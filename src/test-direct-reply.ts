import logger from './utils/logger';
import { config } from './utils/config';
import { 
    postReplyToTweet, 
    initializeDaemonBrowser, 
    extractSpaceId, 
    clickPlayButtonAndCaptureM3u8 // Import the new helper
} from './services/twitterInteractionService';
import { downloadAndUploadAudio } from './services/audioService';
import { createDubbingProject, generateSharingLink, waitForProjectCompletion } from './services/speechlabApiService';
import { Browser, Page, BrowserContext, Locator } from 'playwright'; // Import Locator
import * as path from 'path';
import * as fs from 'fs';

// The specific tweet URL provided by the user (the MENTION tweet)
const TEST_MENTION_TWEET_URL = "https://x.com/RyanAtSpeechlab/status/1911112454756773919";
const TEST_USERNAME = "RyanAtSpeechlab"; // Manually specify username for replies

// Reply texts
const NO_SPACE_FOUND_REPLY = `@${TEST_USERNAME} Sorry, I couldn't find a playable Twitter Space associated with this tweet.`; // Updated message
const PROCESSING_ERROR_REPLY = `@${TEST_USERNAME} Sorry, I encountered an error processing this Space. Please try again later.`;
const SUCCESS_REPLY_TEMPLATE = (duration: number, link: string) => 
    `@${TEST_USERNAME} I've translated this ${duration}-minute Space to English! Listen here: ${link}`;

/**
 * Helper to find the article containing the Play Recording button
 */
async function findArticleWithPlayButton(page: Page): Promise<Locator | null> {
    logger.info('[🧪 Test Helper] Searching for article containing Play Recording button...');
    const playRecordingSelectors = [
        'button[aria-label*="Play recording"]', 
        'button:has-text("Play recording")'
    ];
    const tweetArticles = await page.locator('article[data-testid="tweet"]').all();
    
    for (let i = 0; i < tweetArticles.length; i++) {
        const article = tweetArticles[i];
        if (!await article.isVisible().catch(() => false)) continue;
        
        for (const selector of playRecordingSelectors) {
            if (await article.locator(selector).isVisible({ timeout: 500 })) {
                logger.info(`[🧪 Test Helper] Found Play Recording button in article ${i+1}.`);
                return article; // Return the Locator for the article
            }
        }
    }
    logger.warn('[🧪 Test Helper] Could not find any article with a Play Recording button.');
    return null;
}

/**
 * Main function to run the full processing flow for the test tweet using Play button click
 */
async function main() {
    logger.level = 'debug'; // Force debug logging
    logger.info(`[🧪 Click Play Test] Starting test for mention tweet: ${TEST_MENTION_TWEET_URL}`);
    logger.info(`[🧪 Click Play Test] LOG_LEVEL forced to: ${logger.level}`);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let finalReplyPosted = false;

    const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots');
    if (!fs.existsSync(SCREENSHOT_DIR)){
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }

    try {
        logger.info('[🧪 Click Play Test] Initializing browser and logging in...');
        const browserInfo = await initializeDaemonBrowser();
        browser = browserInfo.browser;
        context = browserInfo.context;
        
        if (!context) {
            throw new Error('Browser context could not be initialized.');
        }
        
        page = await context.newPage();
        logger.info('[🧪 Click Play Test] Browser initialized and logged in.');

        // --- Navigate and Find Article with Play Button --- 
        logger.info(`[🧪 Click Play Test] Navigating to ${TEST_MENTION_TWEET_URL} and looking for Play button...`);
        await page.goto(TEST_MENTION_TWEET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        
        let articleWithPlayButton: Locator | null = await findArticleWithPlayButton(page);
        
        // If not found initially, scroll up and try again
        if (!articleWithPlayButton) {
            logger.info('[🧪 Click Play Test] Play button not found initially. Scrolling up...');
            const MAX_SCROLL_UP = 5; 
            for (let i = 0; i < MAX_SCROLL_UP && !articleWithPlayButton; i++) {
                 logger.info(`[🧪 Click Play Test] Scroll up attempt ${i+1}/${MAX_SCROLL_UP}`);
                 await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
                 await page.waitForTimeout(1500);
                 articleWithPlayButton = await findArticleWithPlayButton(page);
            }
        }

        if (!articleWithPlayButton) {
            logger.warn(`[🧪 Click Play Test] Could not find article with Play button after scrolling. Posting reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, NO_SPACE_FOUND_REPLY);
            finalReplyPosted = true;
            return; 
        }
        logger.info(`[🧪 Click Play Test] Found article containing Play button.`);
        await articleWithPlayButton.screenshot({ path: path.join(SCREENSHOT_DIR, 'found-article-with-play.png')});

        // --- Click Play and Capture M3U8 --- 
        logger.info(`[🧪 Click Play Test] Attempting to click Play and capture M3U8...`);
        const m3u8Url = await clickPlayButtonAndCaptureM3u8(page, articleWithPlayButton);

        if (!m3u8Url) {
            logger.error(`[🧪 Click Play Test] Failed to capture M3U8 URL after clicking Play. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
            finalReplyPosted = true;
            return;
        }
        logger.info(`[🧪 Click Play Test] Captured M3U8 URL: ${m3u8Url}`);

        // --- Extract Space ID (Best Effort) ---
        // Try to get Space ID from the M3U8 URL itself or fallback
        let spaceId = m3u8Url.match(/([a-zA-Z0-9_-]+)\/(?:chunk|playlist)/)?.[1] || `space_${Date.now()}`;
        logger.info(`[🧪 Click Play Test] Using Space ID (best effort): ${spaceId}`);
        
        // --- Process the Space (Same as before) --- 
        logger.info(`[🧪 Click Play Test] Downloading audio and uploading to S3...`);
        const audioUploadResult = await downloadAndUploadAudio(m3u8Url, spaceId);
        if (!audioUploadResult) {
            logger.error(`[🧪 Click Play Test] Failed to download/upload audio. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
            finalReplyPosted = true;
            return;
        }
        logger.info(`[🧪 Click Play Test] Audio uploaded to S3: ${audioUploadResult}`);

        logger.info(`[🧪 Click Play Test] Creating SpeechLab project...`);
        const projectCreationResult = await createDubbingProject(audioUploadResult, spaceId);
        if (!projectCreationResult) {
            logger.error(`[🧪 Click Play Test] Failed to create SpeechLab project. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
            finalReplyPosted = true;
            return;
        }
        const projectId = projectCreationResult; 
        logger.info(`[🧪 Click Play Test] SpeechLab project created: ${projectId}`);

        logger.info(`[🧪 Click Play Test] Waiting for SpeechLab project completion...`);
        const projectCompleted = await waitForProjectCompletion(projectId);
        if (!projectCompleted) {
            logger.error(`[🧪 Click Play Test] SpeechLab project failed or timed out. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
            finalReplyPosted = true;
            return;
        }
        logger.info(`[🧪 Click Play Test] SpeechLab project completed.`);

        logger.info(`[🧪 Click Play Test] Generating sharing link...`);
        const sharingLink = await generateSharingLink(projectId);
        if (!sharingLink) {
            logger.error(`[🧪 Click Play Test] Failed to generate sharing link. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
            finalReplyPosted = true;
            return;
        }
        logger.info(`[🧪 Click Play Test] Sharing link: ${sharingLink}`);

        logger.info(`[🧪 Click Play Test] Posting final success reply...`);
        const estimatedDurationMinutes = 10; 
        const successReply = SUCCESS_REPLY_TEMPLATE(estimatedDurationMinutes, sharingLink);
        const postSuccess = await postReplyToTweet(page, TEST_MENTION_TWEET_URL, successReply);
        finalReplyPosted = true;

        if (postSuccess) {
            logger.info(`[🧪 Click Play Test] ✅ Successfully posted final reply to: ${TEST_MENTION_TWEET_URL}`);
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-click-play-success.png') });
        } else {
            logger.error(`[🧪 Click Play Test] ❌ Failed to post final reply to: ${TEST_MENTION_TWEET_URL}`);
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-click-play-failure.png') });
        }

    } catch (error) {
        logger.error(`[🧪 Click Play Test] ❌ Uncaught Error during test:`, error);
        if (page && !page.isClosed() && !finalReplyPosted) {
             logger.info(`[🧪 Click Play Test] Attempting to post generic error reply due to exception...`);
             await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
             await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-click-play-exception-error.png') });
        }
    } finally {
        logger.info('[🧪 Click Play Test] Cleaning up browser...');
        try {
            if (page && !page.isClosed()) {
                await page.close();
            }
        } catch (e) { logger.warn('[🧪 Click Play Test] Error closing page', e); }
        try {
            if (context) {
                await context.close();
            }
        } catch (e) { logger.warn('[🧪 Click Play Test] Error closing context', e); }
        try {
            if (browser) {
                await browser.close();
            }
        } catch (e) { logger.warn('[🧪 Click Play Test] Error closing browser', e); }
        logger.info('[🧪 Click Play Test] Cleanup complete.');
    }
}

// Run the main function
main().catch(error => {
    logger.error("[🧪 Click Play Test] Unhandled error in main execution:", error);
    process.exit(1);
}); 