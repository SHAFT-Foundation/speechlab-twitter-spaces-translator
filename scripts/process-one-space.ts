#!/usr/bin/env tsx
/**
 * Process ONLY a single Space tweet - completely isolated
 * Does NOT start the daemon or process other tweets
 */

import { config } from '../src/utils/config.js';
import logger from '../src/utils/logger.js';
import { fetchVideoForMention } from '../src/services/twitterMentionService.js';
import { updateMentionStatus, getMention } from '../src/services/supabaseService.js';

async function processSingleSpace() {
    const tweetId = process.argv[2];
    if (!tweetId) {
        console.error('Usage: npx tsx scripts/process-one-space.ts <tweet_id>');
        process.exit(1);
    }

    logger.info(`\n${'='.repeat(80)}`);
    logger.info(`[SINGLE TWEET TEST] Processing ONLY tweet: ${tweetId}`);
    logger.info(`${'='.repeat(80)}\n`);

    // Fetch mention
    const mention = await getMention(tweetId);
    if (!mention) {
        logger.error(`[TEST] Mention ${tweetId} not found`);
        process.exit(1);
    }

    logger.info(`[TEST] Found mention: @${mention.username}`);
    logger.info(`[TEST] Current status: ${mention.status}`);
    logger.info(`[TEST] Current content_type: ${mention.content_type}`);

    // Update to initiating
    logger.info(`\n[TEST] Updating status to 'initiating'...`);
    await updateMentionStatus(tweetId, 'initiating');

    // Fetch Space URL
    logger.info(`[TEST] Calling fetchVideoForMention()...`);
    const { videoUrl, parentTweetId } = await fetchVideoForMention(tweetId);

    if (!videoUrl) {
        logger.error(`[TEST] No URL found`);
        process.exit(1);
    }

    logger.info(`[TEST] Found URL: ${videoUrl}`);

    // Check if Space
    const isSpaceUrl = videoUrl.match(/https:\/\/(?:twitter|x)\.com\/i\/spaces\/([a-zA-Z0-9]+)/);
    if (!isSpaceUrl) {
        logger.info(`[TEST] Not a Space - it's a video`);
        process.exit(0);
    }

    logger.info(`[TEST] ✅ Space detected: ${isSpaceUrl[1]}`);
    logger.info(`\n[TEST] To process this Space, the daemon needs to:`);
    logger.info(`[TEST]   1. Launch Playwright browser`);
    logger.info(`[TEST]   2. Navigate to Space and click Play`);
    logger.info(`[TEST]   3. Capture m3u8 URL from network`);
    logger.info(`[TEST]   4. Send to SpeechLab for dubbing`);
    logger.info(`\n[TEST] Run the daemon to complete processing:`);
    logger.info(`[TEST]   node dist/mentionDaemon.js`);

    process.exit(0);
}

processSingleSpace().catch(console.error);
