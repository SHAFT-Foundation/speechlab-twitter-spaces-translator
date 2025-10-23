import logger from './utils/logger';
import { config } from './utils/config';
import { fetchMentions, postReplyWithMedia, MentionData } from './services/twitterMentionService';
import { createDubbingProject, waitForProjectCompletion, generateSharingLink } from './services/speechlabApiService';
import { downloadAndUploadAudio } from './services/audioService';
import { getLanguageName, detectLanguage } from './utils/languageUtils';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Twitter Mention Daemon - Twitter API Implementation
 *
 * This daemon polls Twitter mentions using the Twitter API, processes dubbing requests,
 * and posts video replies back to mentions.
 */

// State management
let lastProcessedMentionId: string | null = null;
const processedMentionIds = new Set<string>();
const STATE_FILE = path.join(process.cwd(), 'mention_daemon_state.json');

/**
 * Load daemon state from disk
 */
function loadState(): void {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            lastProcessedMentionId = state.lastProcessedMentionId || null;

            if (state.processedMentionIds && Array.isArray(state.processedMentionIds)) {
                state.processedMentionIds.forEach((id: string) => processedMentionIds.add(id));
            }

            logger.info(`[💾 State] Loaded state: last processed ID = ${lastProcessedMentionId}, ${processedMentionIds.size} processed mentions`);
        } else {
            logger.info('[💾 State] No existing state file found, starting fresh');
        }
    } catch (error) {
        logger.error('[💾 State] ❌ Error loading state:', error);
    }
}

/**
 * Save daemon state to disk
 */
function saveState(): void {
    try {
        const state = {
            lastProcessedMentionId,
            processedMentionIds: Array.from(processedMentionIds),
            lastSaved: new Date().toISOString()
        };

        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        logger.debug(`[💾 State] State saved: ${processedMentionIds.size} processed mentions`);
    } catch (error) {
        logger.error('[💾 State] ❌ Error saving state:', error);
    }
}

/**
 * Process a single mention and create dubbed video response
 */
async function processMention(mention: MentionData): Promise<boolean> {
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info(`[🔄 Process] Processing mention from @${mention.username}`);
    logger.info(`[🔄 Process] Tweet ID: ${mention.tweetId}`);
    logger.info(`[🔄 Process] Text: "${mention.text}"`);
    logger.info('═══════════════════════════════════════════════════════════');

    try {
        // Extract Space ID from mention text using regex
        const spaceIdRegex = /(?:https?:\/\/)?(?:twitter\.com|x\.com)\/i\/spaces\/([a-zA-Z0-9]+)/;
        const match = mention.text.match(spaceIdRegex);

        if (!match || !match[1]) {
            logger.warn(`[🔄 Process] ⚠️ No Space ID found in mention text`);

            // Reply with error message
            const errorText = `@${mention.username} Sorry, I couldn't find a Twitter Space URL in your mention. Please include a Space URL like: https://twitter.com/i/spaces/[SPACE_ID]`;
            await postReplyWithMedia(errorText, mention.tweetId);

            return false;
        }

        const spaceId = match[1];
        logger.info(`[🔄 Process] ✅ Found Space ID: ${spaceId}`);

        // Construct Space URL
        const spaceUrl = `https://twitter.com/i/spaces/${spaceId}`;
        logger.info(`[🔄 Process] Space URL: ${spaceUrl}`);

        // Detect target language from mention text
        const targetLanguage = detectLanguage(mention.text);
        logger.info(`[🔄 Process] Target language: ${getLanguageName(targetLanguage)}`);

        // For now, we'll skip M3U8 extraction and use a placeholder
        // In production, you'd need to extract the M3U8 URL from the Space
        // This would require either Playwright scraping or Twitter's API if available

        logger.warn(`[🔄 Process] ⚠️ M3U8 extraction not yet implemented for API-only flow`);
        logger.warn(`[🔄 Process] ⚠️ This is a limitation - Twitter API doesn't provide Space audio URLs`);

        // Reply indicating limitation
        const limitationText = `@${mention.username} Thanks for your request! Currently working on API-only implementation. Space audio extraction requires additional development.`;
        await postReplyWithMedia(limitationText, mention.tweetId);

        return false;

        // TODO: Full implementation would look like this:
        // 1. Extract M3U8 URL (requires Playwright or Space API access)
        // 2. Download and upload audio
        // 3. Create dubbing project
        // 4. Wait for completion
        // 5. Generate sharing link
        // 6. Create video with dubbed audio
        // 7. Post video reply

    } catch (error) {
        logger.error(`[🔄 Process] ❌ Error processing mention:`, error);

        try {
            const errorText = `@${mention.username} Sorry, I encountered an error processing your request. Please try again later.`;
            await postReplyWithMedia(errorText, mention.tweetId);
        } catch (replyError) {
            logger.error(`[🔄 Process] ❌ Failed to send error reply:`, replyError);
        }

        return false;
    }
}

/**
 * Main polling loop
 */
async function pollMentions(): Promise<void> {
    logger.info('[🔁 Poll] Starting mention poll cycle...');

    try {
        // Fetch mentions
        const mentions = await fetchMentions(lastProcessedMentionId || undefined);

        if (mentions.length === 0) {
            logger.info('[🔁 Poll] No new mentions found');
            return;
        }

        logger.info(`[🔁 Poll] Found ${mentions.length} new mention(s)`);

        // Process mentions in reverse order (oldest first)
        const mentionsToProcess = mentions.reverse();

        for (const mention of mentionsToProcess) {
            // Skip if already processed
            if (processedMentionIds.has(mention.tweetId)) {
                logger.debug(`[🔁 Poll] Skipping already processed mention: ${mention.tweetId}`);
                continue;
            }

            // Process mention
            logger.info(`[🔁 Poll] Processing mention ${mention.tweetId}...`);
            const success = await processMention(mention);

            // Mark as processed regardless of success
            processedMentionIds.add(mention.tweetId);
            lastProcessedMentionId = mention.tweetId;

            // Save state after each mention
            saveState();

            logger.info(`[🔁 Poll] Mention ${mention.tweetId} ${success ? '✅ completed' : '⚠️ failed'}`);

            // Wait between mentions to avoid rate limits
            logger.info(`[🔁 Poll] Waiting ${config.DELAY_BETWEEN_PROFILES_MS / 1000}s before next mention...`);
            await new Promise(resolve => setTimeout(resolve, config.DELAY_BETWEEN_PROFILES_MS));
        }

        logger.info('[🔁 Poll] ✅ Poll cycle completed');

    } catch (error) {
        logger.error('[🔁 Poll] ❌ Error in poll cycle:', error);
    }
}

/**
 * Start the mention daemon
 */
async function startDaemon(): Promise<void> {
    logger.info('═══════════════════════════════════════════════════════════');
    logger.info('🚀 Starting Twitter Mention Daemon (API Implementation)');
    logger.info('═══════════════════════════════════════════════════════════');

    // Load previous state
    loadState();

    // Polling interval from config (default 5 minutes)
    const pollIntervalMs = config.MENTION_POLL_INTERVAL_MS || 300000;
    logger.info(`[⚙️ Config] Poll interval: ${pollIntervalMs / 1000}s (${pollIntervalMs / 60000}m)`);
    logger.info(`[⚙️ Config] Delay between mentions: ${config.DELAY_BETWEEN_PROFILES_MS / 1000}s`);

    // Initial poll
    await pollMentions();

    // Set up polling interval
    setInterval(async () => {
        await pollMentions();
    }, pollIntervalMs);

    logger.info('[✅ Daemon] Mention daemon is now running');
    logger.info('[✅ Daemon] Press Ctrl+C to stop');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('\n[🛑 Shutdown] Received SIGINT, saving state and shutting down...');
    saveState();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('\n[🛑 Shutdown] Received SIGTERM, saving state and shutting down...');
    saveState();
    process.exit(0);
});

// Start the daemon
startDaemon().catch(error => {
    logger.error('[❌ Fatal] Fatal error in daemon:', error);
    saveState();
    process.exit(1);
});
