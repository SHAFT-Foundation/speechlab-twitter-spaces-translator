#!/usr/bin/env tsx
/**
 * Translate Parent Tweet Texts
 *
 * Fetches parent tweet text and translates it to the target language
 */

import { createClient } from '@supabase/supabase-js';
import { TwitterApi } from 'twitter-api-v2';
import { config } from '../src/utils/config';
import logger from '../src/utils/logger';
import OpenAI from 'openai';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

const twitterClient = new TwitterApi({
    appKey: config.TWITTER_API_KEY,
    appSecret: config.TWITTER_API_SECRET,
    accessToken: config.TWITTER_ACCESS_TOKEN,
    accessSecret: config.TWITTER_ACCESS_SECRET,
});
const rwClient = twitterClient.readWrite;

const openai = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
});

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const LANGUAGE_MAP: Record<string, string> = {
    'es': 'Spanish',
    'es_la': 'Spanish (Latin America)',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'pt': 'Portuguese',
    'pt_br': 'Portuguese (Brazil)',
    'ja': 'Japanese',
    'ko': 'Korean',
    'zh': 'Chinese (Simplified)',
    'zh_tw': 'Chinese (Traditional)',
    'ar': 'Arabic',
    'hi': 'Hindi',
    'ru': 'Russian',
    'id': 'Indonesian',
    'tr': 'Turkish',
    'nl': 'Dutch',
    'pl': 'Polish',
    'sv': 'Swedish',
    'da': 'Danish',
    'no': 'Norwegian',
    'fi': 'Finnish'
};

async function translateText(text: string, targetLanguage: string): Promise<string> {
    const languageName = LANGUAGE_MAP[targetLanguage] || targetLanguage;

    const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{
            role: 'user',
            content: `Translate the following tweet text to ${languageName}. Only return the translation, no explanations or additional text:\n\n${text}`
        }],
        max_tokens: 500,
        temperature: 0.3
    });

    const translated = completion.choices[0]?.message?.content?.trim();
    if (translated) {
        return translated;
    }

    return text; // Fallback to original if translation fails
}

async function translateParentTweets() {
    try {
        logger.info('[🌐 Translation] Starting parent tweet translation...');

        // Calculate 2 weeks ago
        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

        // Get mentions without translated parent text from last 2 weeks
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('tweet_id, parent_tweet_url, parent_tweet_text, target_language')
            .eq('status', 'complete')
            .not('parent_tweet_url', 'is', null)
            .is('parent_tweet_text_translated', null)
            .gte('created_at', twoWeeksAgo.toISOString())
            .order('created_at', { ascending: false })
            .limit(100); // Process 100 at a time

        if (error) {
            logger.error('[🌐 Translation] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[🌐 Translation] No mentions need translation');
            return;
        }

        logger.info(`[🌐 Translation] Found ${mentions.length} mentions to translate`);

        let processedCount = 0;
        let errorCount = 0;

        for (const mention of mentions) {
            try {
                // Extract parent tweet ID from URL
                const parentTweetId = mention.parent_tweet_url.match(/status\/(\d+)/)?.[1];
                if (!parentTweetId) {
                    logger.warn(`[🌐 Translation] Could not extract parent tweet ID from ${mention.parent_tweet_url}`);
                    errorCount++;
                    continue;
                }

                logger.info(`\n[🌐 Translation] Processing mention ${mention.tweet_id}...`);

                // Get parent tweet text if we don't have it
                let parentText = mention.parent_tweet_text;
                if (!parentText) {
                    logger.info(`[🌐 Translation] Fetching parent tweet text...`);
                    const tweet = await rwClient.v2.singleTweet(parentTweetId, {
                        'tweet.fields': 'text'
                    });

                    if (tweet.data?.text) {
                        parentText = tweet.data.text;
                        // Save parent text to mentions table
                        await supabase
                            .from('mentions')
                            .update({ parent_tweet_text: parentText })
                            .eq('tweet_id', mention.tweet_id);
                    } else {
                        logger.warn(`[🌐 Translation] Could not fetch parent tweet ${parentTweetId}`);
                        errorCount++;
                        continue;
                    }
                    await sleep(1000); // Rate limit protection
                }

                // Translate to target language
                logger.info(`[🌐 Translation] Translating to ${mention.target_language}...`);
                const translatedText = await translateText(parentText, mention.target_language);
                logger.info(`[🌐 Translation] ✅ Translated: "${translatedText.substring(0, 100)}${translatedText.length > 100 ? '...' : ''}"`);

                // Save translated text
                const { error: updateError } = await supabase
                    .from('mentions')
                    .update({
                        parent_tweet_text_translated: translatedText,
                        updated_at: new Date().toISOString()
                    })
                    .eq('tweet_id', mention.tweet_id);

                if (updateError) {
                    logger.error(`[🌐 Translation] Error saving translation for ${mention.tweet_id}:`, updateError);
                    errorCount++;
                } else {
                    processedCount++;
                    logger.info(`[🌐 Translation] ✅ Saved translation for ${mention.tweet_id}`);
                }

                // Rate limit: Be gentle with Claude API
                await sleep(2000);

            } catch (error: any) {
                if (error.code === 429) {
                    logger.warn('[🌐 Translation] Rate limited! Waiting 1 minute...');
                    await sleep(60 * 1000);
                    continue;
                }
                logger.error(`[🌐 Translation] Error processing ${mention.tweet_id}:`, error);
                errorCount++;
            }
        }

        logger.info('\n========================================');
        logger.info('[🌐 Translation] Parent Tweet Translation Complete!');
        logger.info('========================================');
        logger.info(`Processed: ${processedCount}/${mentions.length}`);
        logger.info(`Errors: ${errorCount}`);
        logger.info('========================================');

        if (processedCount > 0) {
            logger.info('\n✅ Next steps:');
            logger.info('  Run: npx tsx scripts/generate-mention-engagement-report.ts');
        }

    } catch (error) {
        logger.error('[🌐 Translation] Fatal error:', error);
        process.exit(1);
    }
}

translateParentTweets()
    .then(() => {
        logger.info('[🌐 Translation] Script completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[🌐 Translation] Script failed:', error);
        process.exit(1);
    });
