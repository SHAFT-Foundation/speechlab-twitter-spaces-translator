import logger from './utils/logger';
import { config } from './utils/config';
import { 
    postReplyToTweet, 
    initializeDaemonBrowser, 
    getM3u8ForSpacePage,
    extractSpaceUrl, 
    extractSpaceId, 
    findSpaceUrlOnPage // Import function to check page
} from './services/twitterInteractionService';
import { downloadAndUploadAudio } from './services/audioService';
import { createDubbingProject, generateSharingLink, waitForProjectCompletion } from './services/speechlabApiService';
import { Browser, Page, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

// The specific tweet URL provided by the user (the MENTION tweet)
const TEST_MENTION_TWEET_URL = "https://x.com/RyanAtSpeechlab/status/1911112454756773919";
const TEST_USERNAME = "RyanAtSpeechlab"; // Manually specify username for replies

// Reply texts
const NO_SPACE_FOUND_REPLY = `@${TEST_USERNAME} Sorry, I couldn't find a Twitter Space link associated with this tweet.`;
const PROCESSING_ERROR_REPLY = `@${TEST_USERNAME} Sorry, I encountered an error processing this Space. Please try again later.`;
const SUCCESS_REPLY_TEMPLATE = (duration: number, link: string) => 
    `@${TEST_USERNAME} I've translated this ${duration}-minute Space to English! Listen here: ${link}`;


/**
 * Helper to simulate findSpaceUrlInTweetThread for the test script
 */
async function findSpaceUrlInTestTweetThread(page: Page, tweetUrl: string): Promise<string | null> {
    logger.info(`[🧪 Test Thread] Navigating to tweet to look for Space URL: ${tweetUrl}`);
    
    try {
        await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        logger.info(`[🧪 Test Thread] Tweet page loaded. Looking for Space URL...`);
        await page.waitForTimeout(3000);
        
        const spaceUrlOnPage = await findSpaceUrlOnPage(page);
        if (spaceUrlOnPage) {
            logger.info(`[🧪 Test Thread] Found Space URL on initial page load: ${spaceUrlOnPage}`);
            return spaceUrlOnPage;
        }
        
        logger.info(`[🧪 Test Thread] No Space URL found initially. Scrolling up...`);
        const MAX_SCROLL_UP = 5; // Reduced scroll attempts for testing
        
        for (let i = 0; i < MAX_SCROLL_UP; i++) {
            logger.info(`[🧪 Test Thread] Scroll up attempt ${i+1}/${MAX_SCROLL_UP}`);
            await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
            await page.waitForTimeout(1500);
            
            const spaceUrl = await findSpaceUrlOnPage(page);
            if (spaceUrl) {
                logger.info(`[🧪 Test Thread] Found Space URL after scrolling up: ${spaceUrl}`);
                return spaceUrl;
            }
            
            const atTop = await page.evaluate(() => window.scrollY === 0);
            if (atTop) {
                logger.info(`[🧪 Test Thread] Reached top of page.`);
                break;
            }
        }
        
        logger.warn(`[🧪 Test Thread] No Space URL found after scrolling.`);
        return null;
    } catch (error) {
        logger.error(`[🧪 Test Thread] Error finding Space URL in test thread:`, error);
        return null;
    }
}

/**
 * Main function to run the full processing flow for the test tweet
 */
async function main() {
    logger.info(`[🧪 Full Flow Test] Starting test for mention tweet: ${TEST_MENTION_TWEET_URL}`);
    logger.info(`[🧪 Full Flow Test] LOG_LEVEL set to: ${config.LOG_LEVEL}`);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let finalReplyPosted = false;

    const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots');
    if (!fs.existsSync(SCREENSHOT_DIR)){
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }

    try {
        logger.info('[🧪 Full Flow Test] Initializing browser and logging in...');
        const browserInfo = await initializeDaemonBrowser();
        browser = browserInfo.browser;
        context = browserInfo.context;
        
        if (!context) {
            throw new Error('Browser context could not be initialized.');
        }
        
        page = await context.newPage();
        logger.info('[🧪 Full Flow Test] Browser initialized and logged in.');

        // --- Find Space URL --- 
        logger.info(`[🧪 Full Flow Test] Attempting to find Space URL for ${TEST_MENTION_TWEET_URL}...`);
        // In a real scenario, we'd check mention text first, but here we go straight to checking the thread
        const spaceUrl = await findSpaceUrlInTestTweetThread(page, TEST_MENTION_TWEET_URL);

        if (!spaceUrl) {
            logger.warn(`[🧪 Full Flow Test] No Space URL found. Posting reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, NO_SPACE_FOUND_REPLY);
            finalReplyPosted = true;
            return; // Exit after posting the failure reply
        }
        logger.info(`[🧪 Full Flow Test] Found Space URL: ${spaceUrl}`);

        // --- Process the Space --- 
        const spaceId = extractSpaceId(spaceUrl);
        if (!spaceId) {
            logger.error(`[🧪 Full Flow Test] Could not extract Space ID from URL: ${spaceUrl}. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY); 
            finalReplyPosted = true;
            return; 
        }
        logger.info(`[🧪 Full Flow Test] Space ID: ${spaceId}`);

        logger.info(`[🧪 Full Flow Test] Getting M3U8 URL...`);
        const m3u8Result = await getM3u8ForSpacePage(spaceUrl, page);
        if (!m3u8Result || !m3u8Result.m3u8Url) {
            logger.error(`[🧪 Full Flow Test] Failed to get M3U8 URL. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
            finalReplyPosted = true;
            return;
        }
        logger.info(`[🧪 Full Flow Test] M3U8 URL: ${m3u8Result.m3u8Url}`);

        logger.info(`[🧪 Full Flow Test] Downloading audio and uploading to S3...`);
        const audioUploadResult = await downloadAndUploadAudio(m3u8Result.m3u8Url, spaceId);
        if (!audioUploadResult) {
            logger.error(`[🧪 Full Flow Test] Failed to download/upload audio. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
            finalReplyPosted = true;
            return;
        }
        logger.info(`[🧪 Full Flow Test] Audio uploaded to S3: ${audioUploadResult}`);

        logger.info(`[🧪 Full Flow Test] Creating SpeechLab project...`);
        // We don't have durationMs here, passing spaceId as the name
        const projectCreationResult = await createDubbingProject(audioUploadResult, spaceId);
        if (!projectCreationResult) {
            logger.error(`[🧪 Full Flow Test] Failed to create SpeechLab project. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
            finalReplyPosted = true;
            return;
        }
        const projectId = projectCreationResult; // Assuming result is just the ID string
        logger.info(`[🧪 Full Flow Test] SpeechLab project created: ${projectId}`);

        logger.info(`[🧪 Full Flow Test] Waiting for SpeechLab project completion...`);
        // Use projectId (string) for waiting
        const projectCompleted = await waitForProjectCompletion(projectId);
        if (!projectCompleted) {
            logger.error(`[🧪 Full Flow Test] SpeechLab project failed or timed out. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
            finalReplyPosted = true;
            return;
        }
        logger.info(`[🧪 Full Flow Test] SpeechLab project completed.`);

        logger.info(`[🧪 Full Flow Test] Generating sharing link...`);
        const sharingLink = await generateSharingLink(projectId);
        if (!sharingLink) {
            logger.error(`[🧪 Full Flow Test] Failed to generate sharing link. Posting error reply.`);
            await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
            finalReplyPosted = true;
            return;
        }
        logger.info(`[🧪 Full Flow Test] Sharing link: ${sharingLink}`);

        logger.info(`[🧪 Full Flow Test] Posting final success reply...`);
        // Use a default duration since we don't have it from the simplified audio result
        const estimatedDurationMinutes = 10; 
        const successReply = SUCCESS_REPLY_TEMPLATE(estimatedDurationMinutes, sharingLink);
        const postSuccess = await postReplyToTweet(page, TEST_MENTION_TWEET_URL, successReply);
        finalReplyPosted = true;

        if (postSuccess) {
            logger.info(`[🧪 Full Flow Test] ✅ Successfully posted final reply to: ${TEST_MENTION_TWEET_URL}`);
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-full-flow-success.png') });
        } else {
            logger.error(`[🧪 Full Flow Test] ❌ Failed to post final reply to: ${TEST_MENTION_TWEET_URL}`);
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-full-flow-failure.png') });
        }

    } catch (error) {
        logger.error(`[🧪 Full Flow Test] ❌ Uncaught Error during test:`, error);
        if (page && !page.isClosed() && !finalReplyPosted) {
             logger.info(`[🧪 Full Flow Test] Attempting to post generic error reply due to exception...`);
             await postReplyToTweet(page, TEST_MENTION_TWEET_URL, PROCESSING_ERROR_REPLY);
             await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-full-flow-exception-error.png') });
        }
    } finally {
        logger.info('[🧪 Full Flow Test] Cleaning up browser...');
        try {
            if (page && !page.isClosed()) {
                await page.close();
            }
        } catch (e) { logger.warn('[🧪 Full Flow Test] Error closing page', e); }
        try {
            if (context) {
                await context.close();
            }
        } catch (e) { logger.warn('[🧪 Full Flow Test] Error closing context', e); }
        try {
            if (browser) {
                await browser.close();
            }
        } catch (e) { logger.warn('[🧪 Full Flow Test] Error closing browser', e); }
        logger.info('[🧪 Full Flow Test] Cleanup complete.');
    }
}

// Run the main function
main().catch(error => {
    logger.error("[🧪 Full Flow Test] Unhandled error in main execution:", error);
    process.exit(1);
}); 