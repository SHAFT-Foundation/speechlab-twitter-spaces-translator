import logger from './utils/logger';
import { config } from './utils/config';
import { postReplyToTweet } from './services/twitterInteractionService';
import { initializeDaemonBrowser } from './mentionDaemon'; // Re-use browser init
import { Browser, Page, BrowserContext } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

// The specific tweet URL provided by the user
const TEST_TWEET_URL = "https://x.com/RyanAtSpeechlab/status/1911112454756773919";

// Sample reply text
const TEST_REPLY_TEXT = `@RyanAtSpeechlab Testing the reply function directly! [${new Date().toISOString()}]`;

/**
 * Main function to run the direct reply test
 */
async function main() {
    logger.info(`[🧪 Direct Reply Test] Starting test for tweet: ${TEST_TWEET_URL}`);
    logger.info(`[🧪 Direct Reply Test] LOG_LEVEL set to: ${config.LOG_LEVEL}`);

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots');
    if (!fs.existsSync(SCREENSHOT_DIR)){
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }

    try {
        logger.info('[🧪 Direct Reply Test] Initializing browser and logging in...');
        const browserInfo = await initializeDaemonBrowser();
        browser = browserInfo.browser;
        context = browserInfo.context;
        
        if (!context) {
            throw new Error('Browser context could not be initialized.');
        }
        
        page = await context.newPage(); // Get a new page from the context
        logger.info('[🧪 Direct Reply Test] Browser initialized and logged in.');

        logger.info(`[🧪 Direct Reply Test] Attempting to post reply: "${TEST_REPLY_TEXT}"`);

        // Call the function we want to test
        const postSuccess = await postReplyToTweet(page, TEST_TWEET_URL, TEST_REPLY_TEXT);

        if (postSuccess) {
            logger.info(`[🧪 Direct Reply Test] ✅ Successfully posted reply to tweet: ${TEST_TWEET_URL}`);
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-direct-reply-success.png') });
        } else {
            logger.error(`[🧪 Direct Reply Test] ❌ Failed to post reply to tweet: ${TEST_TWEET_URL}`);
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-direct-reply-failure.png') });
        }

    } catch (error) {
        logger.error(`[🧪 Direct Reply Test] ❌ Error during test:`, error);
        if (page && !page.isClosed()) {
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'test-direct-reply-error.png') });
        }
    } finally {
        logger.info('[🧪 Direct Reply Test] Cleaning up browser...');
        try {
            if (page && !page.isClosed()) {
                await page.close();
            }
        } catch (e) { logger.warn('[🧪 Direct Reply Test] Error closing page', e); }
        try {
            if (context) {
                await context.close();
            }
        } catch (e) { logger.warn('[🧪 Direct Reply Test] Error closing context', e); }
        try {
            if (browser) {
                await browser.close();
            }
        } catch (e) { logger.warn('[🧪 Direct Reply Test] Error closing browser', e); }
        logger.info('[🧪 Direct Reply Test] Cleanup complete.');
    }
}

// Run the main function
main().catch(error => {
    logger.error("[🧪 Direct Reply Test] Unhandled error in main execution:", error);
    process.exit(1);
}); 