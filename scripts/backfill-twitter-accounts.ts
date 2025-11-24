#!/usr/bin/env tsx
/**
 * Backfill twitter_accounts table with profile images from existing mentions
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

async function backfillTwitterAccounts() {
    try {
        logger.info('[Backfill Accounts] Starting twitter_accounts table backfill...');

        // Get all unique usernames from mentions table (both mention authors and parent authors)
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('username, parent_username')
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('[Backfill Accounts] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[Backfill Accounts] No mentions found');
            return;
        }

        // Collect unique usernames
        const uniqueUsernames = new Set<string>();
        for (const mention of mentions) {
            if (mention.username) {
                uniqueUsernames.add(mention.username);
            }
            if (mention.parent_username) {
                uniqueUsernames.add(mention.parent_username);
            }
        }

        logger.info(`[Backfill Accounts] Found ${uniqueUsernames.size} unique Twitter usernames`);

        // Check which accounts already exist
        const { data: existingAccounts } = await supabase
            .from('twitter_accounts')
            .select('username');

        const existingUsernames = new Set(existingAccounts?.map(a => a.username) || []);
        const usernamesToFetch = Array.from(uniqueUsernames).filter(u => !existingUsernames.has(u));

        logger.info(`[Backfill Accounts] ${existingUsernames.size} already exist, fetching ${usernamesToFetch.length} new accounts`);

        if (usernamesToFetch.length === 0) {
            logger.info('[Backfill Accounts] All accounts already in database');
            return;
        }

        let successCount = 0;
        let errorCount = 0;

        // Fetch and store each account
        for (const username of usernamesToFetch) {
            try {
                logger.info(`[Backfill Accounts] Fetching @${username}...`);

                const user = await rwClient.v2.userByUsername(username, {
                    'user.fields': 'id,name,username,profile_image_url'
                });

                if (user.data) {
                    const { error: insertError } = await supabase
                        .from('twitter_accounts')
                        .upsert({
                            username: user.data.username,
                            user_id: user.data.id,
                            display_name: user.data.name,
                            profile_image_url: user.data.profile_image_url,
                            updated_at: new Date().toISOString()
                        }, {
                            onConflict: 'username'
                        });

                    if (insertError) {
                        logger.error(`[Backfill Accounts] Error inserting @${username}:`, insertError);
                        errorCount++;
                    } else {
                        logger.info(`[Backfill Accounts] ✅ Stored @${username}: ${user.data.profile_image_url}`);
                        successCount++;
                    }
                } else {
                    logger.warn(`[Backfill Accounts] No data for @${username}`);
                    errorCount++;
                }

                // Rate limit protection - 300 requests per 15 minutes = 1 per 3 seconds
                await sleep(3000);

            } catch (error: any) {
                if (error.code === 429) {
                    logger.warn('[Backfill Accounts] Rate limited. Waiting 15 minutes...');
                    await sleep(15 * 60 * 1000);
                    continue;
                }
                logger.error(`[Backfill Accounts] Error fetching @${username}:`, error);
                errorCount++;
            }
        }

        logger.info('\n[Backfill Accounts] ========================================');
        logger.info('[Backfill Accounts] Twitter Accounts Backfill Complete!');
        logger.info(`[Backfill Accounts] Total unique usernames: ${uniqueUsernames.size}`);
        logger.info(`[Backfill Accounts] Already existed: ${existingUsernames.size}`);
        logger.info(`[Backfill Accounts] Newly added: ${successCount}`);
        logger.info(`[Backfill Accounts] Errors: ${errorCount}`);
        logger.info('[Backfill Accounts] ========================================');

    } catch (error) {
        logger.error('[Backfill Accounts] Fatal error:', error);
        process.exit(1);
    }
}

backfillTwitterAccounts()
    .then(() => {
        logger.info('[Backfill Accounts] Script completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[Backfill Accounts] Script failed:', error);
        process.exit(1);
    });
