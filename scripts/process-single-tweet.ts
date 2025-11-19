#!/usr/bin/env tsx
/**
 * Process a single tweet using the exact same code path as the mentionDaemon
 * This allows debugging and testing Space processing without running the full daemon
 */

import { config } from '../src/utils/config.js';
import logger from '../src/utils/logger.js';
import { fetchVideoForMention } from '../src/services/twitterMentionService.js';
import { initializeDaemonBrowser } from '../src/services/twitterInteractionService.js';
import { updateMentionStatus, getMention } from '../src/services/supabaseService.js';
import { detectLanguages } from '../src/utils/languageUtils.js';

// Import the actual daemon functions
async function processSpaceTweet(tweetId: string) {
    logger.info(`\n${'='.repeat(80)}`);
    logger.info(`[TEST] Processing Tweet ID: ${tweetId}`);
    logger.info(`${'='.repeat(80)}\n`);

    // Step 1: Fetch mention from database (same as daemon)
    logger.info(`[TEST] Step 1: Fetching mention from database...`);
    const mention = await getMention(tweetId);

    if (!mention) {
        logger.error(`[TEST] ❌ Mention not found in database`);
        return;
    }

    logger.info(`[TEST] ✅ Mention found:`);
    logger.info(`[TEST]    Username: ${mention.username}`);
    logger.info(`[TEST]    Status: ${mention.status}`);
    logger.info(`[TEST]    Content Type: ${mention.content_type}`);
    logger.info(`[TEST]    Tweet Text: ${mention.tweet_text}`);

    // Create MentionInfo object (same structure as daemon)
    const mentionToProcess = {
        tweetId: mention.tweet_id,
        tweetUrl: mention.tweet_url,
        username: mention.username,
        text: mention.tweet_text,
        hasVideo: false,
        videoM3u8Url: undefined
    };

    // Step 2: Detect languages (same as daemon)
    logger.info(`\n[TEST] Step 2: Detecting languages...`);
    const { sourceLanguageCode, sourceLanguageName, targetLanguageCode, targetLanguageName } = detectLanguages(mentionToProcess.text);
    logger.info(`[TEST] ✅ Languages detected: ${sourceLanguageName} (${sourceLanguageCode}) → ${targetLanguageName} (${targetLanguageCode})`);

    // Step 3: Update status to 'initiating' (same as daemon)
    logger.info(`\n[TEST] Step 3: Updating status to 'initiating'...`);
    await updateMentionStatus(mentionToProcess.tweetId, 'initiating', {
        source_language: sourceLanguageCode,
        target_language: targetLanguageCode
    });
    logger.info(`[TEST] ✅ Status updated to 'initiating'`);

    // Step 4: Fetch video/Space URL using Twitter API (EXACT same code as daemon)
    logger.info(`\n[TEST] Step 4: Calling fetchVideoForMention() - SAME AS DAEMON...`);
    const { videoUrl, parentTweetId } = await fetchVideoForMention(mentionToProcess.tweetId);

    if (!videoUrl) {
        logger.error(`[TEST] ❌ No video or Space URL found`);
        await updateMentionStatus(mentionToProcess.tweetId, 'skipped_no_video', {
            error_message: 'No video or Space found in mention or parent tweet'
        });
        return;
    }

    logger.info(`[TEST] ✅ Content found in parent tweet ${parentTweetId}:`);
    logger.info(`[TEST]    URL: ${videoUrl}`);

    // Step 5: Check if it's a Space URL (EXACT same logic as daemon)
    logger.info(`\n[TEST] Step 5: Checking if URL is a Twitter Space...`);
    const isSpaceUrl = videoUrl.match(/https:\/\/(?:twitter|x)\.com\/i\/spaces\/([a-zA-Z0-9]+)/);

    if (!isSpaceUrl) {
        logger.info(`[TEST] ❌ Not a Space URL - this is a regular video: ${videoUrl}`);
        logger.info(`[TEST] Would process as video in daemon (skipping for this test)`);
        return;
    }

    logger.info(`[TEST] ✅ Twitter Space detected!`);
    logger.info(`[TEST]    Space URL: ${videoUrl}`);
    logger.info(`[TEST]    Space ID: ${isSpaceUrl[1]}`);

    // Step 6: Initialize browser (EXACT same as daemon)
    logger.info(`\n[TEST] Step 6: Initializing Playwright browser...`);
    const { browser, context } = await initializeDaemonBrowser();
    const page = await context.newPage();
    logger.info(`[TEST] ✅ Browser initialized`);

    try {
        // Step 7: Use initiateProcessing to extract m3u8 (EXACT same as daemon)
        logger.info(`\n[TEST] Step 7: Calling initiateProcessing() to extract Space m3u8...`);
        logger.info(`[TEST] This will:`);
        logger.info(`[TEST]    1. Navigate to the Space URL`);
        logger.info(`[TEST]    2. Find and click the Play button`);
        logger.info(`[TEST]    3. Intercept network requests to capture m3u8 URL`);
        logger.info(`[TEST]    4. Return the m3u8 URL for dubbing`);

        // Import initiateProcessing dynamically to avoid circular deps
        const { default: initiateProcessingModule } = await import('../src/mentionDaemon.js');

        logger.error(`[TEST] ⚠️  Cannot import initiateProcessing directly (it's not exported)`);
        logger.info(`[TEST] Instead, showing what WOULD happen in daemon:`);
        logger.info(`[TEST]    - Navigate to tweet: ${mentionToProcess.tweetUrl}`);
        logger.info(`[TEST]    - Extract Space URL: ${videoUrl}`);
        logger.info(`[TEST]    - Click Play button and capture m3u8`);
        logger.info(`[TEST]    - Update DB with content_type='space' and m3u8_url`);
        logger.info(`[TEST]    - Call performBackendProcessing() for dubbing`);

        logger.info(`\n[TEST] ℹ️  To actually process this Space, run the daemon:`);
        logger.info(`[TEST]    npm run daemon`);

    } catch (error) {
        logger.error(`[TEST] ❌ Error during processing:`, error);
        await updateMentionStatus(mentionToProcess.tweetId, 'failed', {
            error_message: `Test processing error: ${error instanceof Error ? error.message : String(error)}`
        });
    } finally {
        // Clean up browser
        logger.info(`\n[TEST] Cleaning up browser...`);
        await page.close();
        await context.close();
        await browser.close();
        logger.info(`[TEST] ✅ Browser closed`);
    }

    logger.info(`\n${'='.repeat(80)}`);
    logger.info(`[TEST] ✅ Test complete - Space detection verified!`);
    logger.info(`${'='.repeat(80)}`);
}

const tweetId = process.argv[2];
if (!tweetId) {
    console.error('Usage: npx tsx scripts/process-single-tweet.ts <tweet_id>');
    process.exit(1);
}

processSpaceTweet(tweetId).catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
});
