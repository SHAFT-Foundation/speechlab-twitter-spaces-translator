#!/usr/bin/env tsx
/**
 * One-time script to backfill missing data in the mentions table
 * - Fetches mentions from the last 2 weeks
 * - For each mention, fetches the parent tweet data from Twitter API
 * - Detects languages from tweet text
 * - Updates the database with missing fields
 */

import { createClient } from '@supabase/supabase-js';
import { TwitterApi } from 'twitter-api-v2';
import { config } from '../src/utils/config';
import { detectLanguages } from '../src/utils/languageUtils';
import logger from '../src/utils/logger';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Initialize Twitter API client
const twitterClient = new TwitterApi({
    appKey: config.TWITTER_API_KEY,
    appSecret: config.TWITTER_API_SECRET,
    accessToken: config.TWITTER_ACCESS_TOKEN,
    accessSecret: config.TWITTER_ACCESS_SECRET,
});
const rwClient = twitterClient.readWrite;

interface MentionRow {
    tweet_id: string;
    username: string;
    tweet_text: string;
    parent_tweet_url?: string;
    parent_tweet_text?: string;
    source_language?: string;
    target_language?: string;
}

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch parent tweet data from Twitter API
 */
async function fetchParentTweetData(mentionTweetId: string): Promise<{
    parentTweetUrl?: string;
    parentTweetText?: string;
    parentUsername?: string;
} | null> {
    try {
        logger.info(`[Backfill] Fetching tweet ${mentionTweetId} from Twitter API...`);

        const tweet = await rwClient.v2.singleTweet(mentionTweetId, {
            'tweet.fields': 'referenced_tweets',
            'expansions': 'referenced_tweets.id,referenced_tweets.id.author_id',
            'user.fields': 'username'
        });

        if (!tweet.data.referenced_tweets || tweet.data.referenced_tweets.length === 0) {
            logger.warn(`[Backfill] Tweet ${mentionTweetId} has no referenced tweets`);
            return null;
        }

        const referencedTweet = tweet.data.referenced_tweets.find(ref => ref.type === 'replied_to');
        if (!referencedTweet) {
            logger.warn(`[Backfill] Tweet ${mentionTweetId} has no replied_to reference`);
            return null;
        }

        // Find parent tweet in includes
        const parentTweet = tweet.includes?.tweets?.find(t => t.id === referencedTweet.id);
        if (!parentTweet) {
            logger.warn(`[Backfill] Parent tweet ${referencedTweet.id} not found in includes`);
            return null;
        }

        // Get parent author username
        let parentUsername: string | undefined;
        if (parentTweet.author_id) {
            const parentAuthor = tweet.includes?.users?.find(u => u.id === parentTweet.author_id);
            parentUsername = parentAuthor?.username;
        }

        const parentTweetUrl = parentUsername
            ? `https://twitter.com/${parentUsername}/status/${referencedTweet.id}`
            : undefined;

        const parentTweetText = parentTweet.text;

        logger.info(`[Backfill] ✅ Found parent tweet data for ${mentionTweetId}`);
        logger.info(`[Backfill]   Parent URL: ${parentTweetUrl}`);
        logger.info(`[Backfill]   Parent text: ${parentTweetText?.substring(0, 100)}...`);

        return {
            parentTweetUrl,
            parentTweetText,
            parentUsername
        };
    } catch (error: any) {
        if (error.code === 429) {
            logger.warn(`[Backfill] Rate limited on tweet ${mentionTweetId}. Waiting 15 minutes...`);
            await sleep(15 * 60 * 1000); // Wait 15 minutes
            return fetchParentTweetData(mentionTweetId); // Retry
        }
        logger.error(`[Backfill] Error fetching parent tweet for ${mentionTweetId}:`, error);
        return null;
    }
}

/**
 * Main backfill function
 */
async function backfillMentionData() {
    try {
        logger.info('[Backfill] Starting backfill process...');

        // Calculate date 2 weeks ago
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

        logger.info(`[Backfill] Fetching mentions since ${twoWeeksAgo.toISOString()}...`);

        // Fetch mentions from last 2 weeks that are missing data
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('tweet_id, username, tweet_text, parent_tweet_url, parent_tweet_text, source_language, target_language')
            .gte('created_at', twoWeeksAgo.toISOString())
            .order('created_at', { ascending: true });

        if (error) {
            logger.error('[Backfill] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[Backfill] No mentions found in the last 2 weeks');
            return;
        }

        logger.info(`[Backfill] Found ${mentions.length} mentions to process`);

        let updatedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const mention of mentions as MentionRow[]) {
            logger.info(`\n[Backfill] Processing mention ${mention.tweet_id}...`);

            // Check what data is missing
            const needsParentData = !mention.parent_tweet_url || !mention.parent_tweet_text;
            const needsLanguages = !mention.source_language || !mention.target_language;

            if (!needsParentData && !needsLanguages) {
                logger.info(`[Backfill] ✓ Mention ${mention.tweet_id} already has all data - skipping`);
                skippedCount++;
                continue;
            }

            const updateData: any = {};

            // Fetch parent tweet data if needed
            if (needsParentData) {
                logger.info(`[Backfill] Fetching parent tweet data for ${mention.tweet_id}...`);
                const parentData = await fetchParentTweetData(mention.tweet_id);

                if (parentData) {
                    if (parentData.parentTweetUrl) updateData.parent_tweet_url = parentData.parentTweetUrl;
                    if (parentData.parentTweetText) updateData.parent_tweet_text = parentData.parentTweetText;
                    if (parentData.parentUsername) updateData.parent_username = parentData.parentUsername;
                }

                // Rate limit protection - wait 2 seconds between API calls
                await sleep(2000);
            }

            // Detect languages if needed
            if (needsLanguages && mention.tweet_text) {
                logger.info(`[Backfill] Detecting languages for ${mention.tweet_id}...`);
                try {
                    const { sourceLanguageCode, targetLanguageCode } = detectLanguages(mention.tweet_text);
                    updateData.source_language = sourceLanguageCode;
                    updateData.target_language = targetLanguageCode;
                    logger.info(`[Backfill] ✅ Detected languages: ${sourceLanguageCode} → ${targetLanguageCode}`);
                } catch (langError) {
                    logger.error(`[Backfill] Error detecting languages:`, langError);
                }
            }

            // Update database if we have any data
            if (Object.keys(updateData).length > 0) {
                logger.info(`[Backfill] Updating mention ${mention.tweet_id} with:`, Object.keys(updateData));

                const { error: updateError } = await supabase
                    .from('mentions')
                    .update({
                        ...updateData,
                        updated_at: new Date().toISOString()
                    })
                    .eq('tweet_id', mention.tweet_id);

                if (updateError) {
                    logger.error(`[Backfill] Error updating mention ${mention.tweet_id}:`, updateError);
                    errorCount++;
                } else {
                    logger.info(`[Backfill] ✅ Successfully updated mention ${mention.tweet_id}`);
                    updatedCount++;
                }
            } else {
                logger.warn(`[Backfill] No data to update for mention ${mention.tweet_id}`);
                skippedCount++;
            }
        }

        logger.info('\n[Backfill] ========================================');
        logger.info('[Backfill] Backfill Complete!');
        logger.info(`[Backfill] Total mentions processed: ${mentions.length}`);
        logger.info(`[Backfill] Updated: ${updatedCount}`);
        logger.info(`[Backfill] Skipped (already complete): ${skippedCount}`);
        logger.info(`[Backfill] Errors: ${errorCount}`);
        logger.info('[Backfill] ========================================');

    } catch (error) {
        logger.error('[Backfill] Fatal error:', error);
        process.exit(1);
    }
}

// Run the backfill
backfillMentionData()
    .then(() => {
        logger.info('[Backfill] Script completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[Backfill] Script failed:', error);
        process.exit(1);
    });
