#!/usr/bin/env tsx
/**
 * Backfill Twitter profile images for existing mentions
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

async function backfillProfileImages() {
    try {
        logger.info('[Backfill Images] Starting profile image backfill...');

        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

        // Fetch mentions missing or with incorrect profile images
        // Note: twitter_profile_image_url should be the PARENT author's profile image
        // We fetch all mentions (not just null ones) to fix any incorrect images
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('tweet_id, username, parent_username, twitter_profile_image_url')
            .gte('created_at', twoWeeksAgo.toISOString())
            .not('parent_username', 'is', null)  // Only process mentions that have a parent
            .order('created_at', { ascending: true });

        if (error) {
            logger.error('[Backfill Images] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[Backfill Images] No mentions to process');
            return;
        }

        logger.info(`[Backfill Images] Found ${mentions.length} mentions to process (fixing profile images)`);

        let updatedCount = 0;
        let errorCount = 0;

        // Group by parent_username to batch fetch user data
        // Note: We're fetching PARENT author profile images, not mention author images
        const usernameMap = new Map<string, string[]>();
        for (const mention of mentions) {
            const parentUsername = mention.parent_username;
            if (!parentUsername) continue;

            if (!usernameMap.has(parentUsername)) {
                usernameMap.set(parentUsername, []);
            }
            usernameMap.get(parentUsername)!.push(mention.tweet_id);
        }

        logger.info(`[Backfill Images] Processing ${usernameMap.size} unique parent usernames...`);

        for (const [parentUsername, tweetIds] of usernameMap.entries()) {
            try {
                logger.info(`[Backfill Images] Fetching profile image for parent author @${parentUsername}...`);

                const user = await rwClient.v2.userByUsername(parentUsername, {
                    'user.fields': 'profile_image_url'
                });

                if (user.data && user.data.profile_image_url) {
                    const profileImageUrl = user.data.profile_image_url;
                    logger.info(`[Backfill Images] ✅ Found profile image for @${parentUsername}: ${profileImageUrl}`);

                    // Update all mentions with this parent_username
                    for (const tweetId of tweetIds) {
                        const { error: updateError } = await supabase
                            .from('mentions')
                            .update({
                                twitter_profile_image_url: profileImageUrl,
                                updated_at: new Date().toISOString()
                            })
                            .eq('tweet_id', tweetId);

                        if (updateError) {
                            logger.error(`[Backfill Images] Error updating ${tweetId}:`, updateError);
                            errorCount++;
                        } else {
                            updatedCount++;
                        }
                    }
                } else {
                    logger.warn(`[Backfill Images] No profile image found for @${parentUsername}`);
                }

                // Rate limit protection - 300 requests per 15 minutes = 1 per 3 seconds
                await sleep(3000);

            } catch (error: any) {
                if (error.code === 429) {
                    logger.warn('[Backfill Images] Rate limited. Waiting 15 minutes...');
                    await sleep(15 * 60 * 1000);
                    // Retry this username
                    continue;
                }
                logger.error(`[Backfill Images] Error fetching @${parentUsername}:`, error);
                errorCount += tweetIds.length;
            }
        }

        logger.info('\n[Backfill Images] ========================================');
        logger.info('[Backfill Images] Profile Image Backfill Complete!');
        logger.info(`[Backfill Images] Unique users: ${usernameMap.size}`);
        logger.info(`[Backfill Images] Mentions updated: ${updatedCount}`);
        logger.info(`[Backfill Images] Errors: ${errorCount}`);
        logger.info('[Backfill Images] ========================================');

    } catch (error) {
        logger.error('[Backfill Images] Fatal error:', error);
        process.exit(1);
    }
}

backfillProfileImages()
    .then(() => {
        logger.info('[Backfill Images] Script completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[Backfill Images] Script failed:', error);
        process.exit(1);
    });
