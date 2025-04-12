import { config } from './utils/config';
import logger from './utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium, Browser, Page, BrowserContext, Locator } from 'playwright';
import { 
    scrapeMentions, 
    MentionInfo, 
    getM3u8ForSpacePage,
    postReplyToTweet
} from './services/twitterInteractionService';
import { downloadAndUploadAudio } from './services/audioService';
import { createDubbingProject, waitForProjectCompletion, generateSharingLink } from './services/speechlabApiService';

// --- Queue for Processing Mentions ---
const mentionQueue: MentionInfo[] = [];
let isProcessingQueue = false; // Flag to prevent concurrent worker runs
// --- END Queue ---

const PROCESSED_MENTIONS_PATH = path.join(process.cwd(), 'processed_mentions.json');
const POLLING_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots');

/**
 * Initializes a Playwright browser instance and context.
 */
async function initializeDaemonBrowser(): Promise<{ browser: Browser, context: BrowserContext }> {
    logger.info('[😈 Daemon Browser] Initializing Playwright browser...');
     // Ensure screenshot directory exists
     if (!await fs.access(SCREENSHOT_DIR).then(() => true).catch(() => false)) {
        await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
        logger.info(`[😈 Daemon] Created screenshot directory: ${SCREENSHOT_DIR}`);
    }
    // Use non-headless mode for debugging
    const isHeadless = false; // Force non-headless mode for debugging
    logger.info(`[😈 Daemon Browser] Launching browser (Headless: ${isHeadless})`);
    const browser = await chromium.launch({ 
        headless: isHeadless, 
        slowMo: isHeadless ? 0 : 250 // Slow down only if not headless
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 900 },
        locale: 'en-US'
    });
    logger.info('[😈 Daemon Browser] ✅ Browser initialized.');
    return { browser, context };
}

/**
 * Logs into Twitter using provided credentials.
 * @param page The Playwright page to use
 * @returns {Promise<boolean>} Success status of login
 */
async function loginToTwitterDaemon(page: Page): Promise<boolean> {
    const username = config.TWITTER_USERNAME;
    const password = config.TWITTER_PASSWORD;
    
    if (!username || !password) {
        logger.error('[😈 Daemon Login] Cannot login: Twitter credentials missing (TWITTER_USERNAME, TWITTER_PASSWORD).');
        return false;
    }
    
    logger.info(`[😈 Daemon Login] Attempting Twitter login: ${username}...`);
    
    try {
        logger.debug('[😈 Daemon Login] Navigating to login page...');
        await page.goto('https://twitter.com/i/flow/login', { waitUntil: 'networkidle', timeout: 60000 });
        logger.debug('[😈 Daemon Login] Login page loaded');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-login-page.png') });
        await page.waitForTimeout(3000);
        
        // Additional debugging - log page URL and title
        logger.info(`[😈 Daemon Login DEBUG] Current Page URL: ${page.url()}`);
        logger.info(`[😈 Daemon Login DEBUG] Current Page Title: ${await page.title()}`);
        
        // Check if we're already logged in by looking for home timeline indicators
        for (const homeSelector of ['[data-testid="AppTabBar_Home_Link"]', 'a[href="/home"]', '[data-testid="SideNav_NewTweet_Button"]']) {
            if (await page.locator(homeSelector).isVisible({ timeout: 2000 }).catch(() => false)) {
                logger.info('[😈 Daemon Login] 🎉 Already logged in! Detected home timeline elements.');
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-already-logged-in.png') });
                return true;
            }
        }
        
        logger.debug('[😈 Daemon Login] Finding username field...');
        const usernameSelectors = [
            'input[autocomplete="username"]', 
            'input[name="text"]',
            'input[data-testid="username_or_email"]',
            'input[type="text"]'
        ];
        let usernameField: Locator | null = null;
        for (const selector of usernameSelectors) {
            logger.debug(`[😈 Daemon Login] Trying username selector: ${selector}`);
            const field = page.locator(selector).first();
            if (await field.isVisible({ timeout: 1000 }).catch(() => false)) { 
                usernameField = field; 
                logger.debug(`[😈 Daemon Login] Found username field with selector: ${selector}`);
                break; 
            }
        }
        if (!usernameField) {
             await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-no-username-field.png') });
             // Log all input fields for debugging
            const inputFields = await page.locator('input').all();
            logger.debug(`[😈 Daemon Login] Found ${inputFields.length} input fields on page:`);
            for (let i = 0; i < inputFields.length && i < 10; i++) {
                const type = await inputFields[i].getAttribute('type') || 'unknown';
                const name = await inputFields[i].getAttribute('name') || 'unknown';
                const id = await inputFields[i].getAttribute('id') || 'unknown';
                logger.debug(`[😈 Daemon Login] Input ${i+1}: type="${type}", name="${name}", id="${id}"`);
            }
             throw new Error('Username field not found');
        }
        
        // Fill username with clear first
        await usernameField.click();
        await usernameField.fill('');
        await usernameField.fill(username);
        await page.waitForTimeout(1000);
        
        logger.debug('[😈 Daemon Login] Finding Next button...');
        const nextButtonSelectors = [
            'div[role="button"]:has-text("Next")', 
            'button:has-text("Next")',
            '[data-testid="LoginForm_Login_Button"]',
            'button[type="submit"]'
        ];
        let nextButton: Locator | null = null;
        for (const selector of nextButtonSelectors) {
            logger.debug(`[😈 Daemon Login] Trying next button selector: ${selector}`);
            const button = page.locator(selector).first();
            if (await button.isVisible({ timeout: 1000 }).catch(() => false)) { 
                nextButton = button; 
                logger.debug(`[😈 Daemon Login] Found next button with selector: ${selector}`);
                break; 
            }
        }
        if (!nextButton) {
             await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-no-next-button.png') });
             throw new Error('Next button not found');
        }
        await nextButton.click();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-after-username.png') });

        // Simplified verification check
        const verificationField = page.locator('input[data-testid="ocfEnterTextTextInput"]').first();
        if (await verificationField.isVisible({ timeout: 1000 }).catch(() => false)) {
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-verification-request.png') });
            throw new Error('Twitter requested verification - manual login may be required first');
        }

        logger.debug('[😈 Daemon Login] Finding password field...');
        const passwordSelectors = [
            'input[name="password"]', 
            'input[type="password"]',
            'input[data-testid="password"]'
        ];
        let passwordField: Locator | null = null;
        for (const selector of passwordSelectors) {
            logger.debug(`[😈 Daemon Login] Trying password selector: ${selector}`);
            const field = page.locator(selector).first();
            if (await field.isVisible({ timeout: 1000 }).catch(() => false)) { 
                passwordField = field; 
                logger.debug(`[😈 Daemon Login] Found password field with selector: ${selector}`);
                break; 
            }
        }
        if (!passwordField) {
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-no-password-field.png') });
            throw new Error('Password field not found');
        }
        
        // Fill password with clear first
        await passwordField.click();
        await passwordField.fill('');
        await passwordField.fill(password);
        await page.waitForTimeout(1000);

        logger.debug('[😈 Daemon Login] Finding Login button...');
        const loginButtonSelectors = [
            '[data-testid="LoginForm_Login_Button"]', 
            'div[role="button"]:has-text("Log in")',
            'button:has-text("Log in")',
            'button[type="submit"]'
        ];
        let loginButton: Locator | null = null;
        for (const selector of loginButtonSelectors) {
            logger.debug(`[😈 Daemon Login] Trying login button selector: ${selector}`);
            const button = page.locator(selector).first();
            if (await button.isVisible({ timeout: 1000 }).catch(() => false)) { 
                loginButton = button; 
                logger.debug(`[😈 Daemon Login] Found login button with selector: ${selector}`);
                break; 
            }
        }
         if (!loginButton) {
             await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-no-login-button.png') });
             throw new Error('Login button not found');
         }
        await loginButton.click();
        await page.waitForTimeout(5000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-after-login-attempt.png') });

        // Check for success indicators
        const successIndicators = [
            '[data-testid="AppTabBar_Home_Link"]', 
            'a[href="/home"]',
            '[data-testid="SideNav_NewTweet_Button"]',
            '[data-testid="primaryColumn"]'
        ];
        
        let isLoggedIn = false;
        for (const selector of successIndicators) {
            logger.debug(`[😈 Daemon Login] Checking success indicator: ${selector}`);
            if (await page.locator(selector).first().isVisible({ timeout: 2000 }).catch(() => false)) {
                logger.info(`[😈 Daemon Login] ✅ Successfully logged in to Twitter (indicator: ${selector})`);
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-login-success.png') });
                isLoggedIn = true;
                break;
            }
        }
        
        if (isLoggedIn) {
            return true;
        }

        // Try navigating to home to confirm login status
        logger.info('[😈 Daemon Login] Attempting to navigate to home page to confirm login status...');
        await page.goto('https://twitter.com/home', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-navigate-to-home.png') });
        
        // Check login status again
        for (const selector of successIndicators) {
            if (await page.locator(selector).first().isVisible({ timeout: 2000 }).catch(() => false)) {
                logger.info(`[😈 Daemon Login] ✅ Successfully confirmed login via home page navigation (indicator: ${selector})`);
                return true;
            }
        }

        // Check for errors
        const errorElem = page.locator('div[role="alert"]').first();
        if (await errorElem.isVisible({ timeout: 1000 }).catch(() => false)) {
             const errorText = await errorElem.textContent() || 'Unknown login error';
             logger.error(`[😈 Daemon Login] Login error detected: ${errorText}`);
             await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-login-error.png') });
             throw new Error(`Twitter login failed: ${errorText}`);
        }

        logger.warn('[😈 Daemon Login] Could not confirm login success/failure. Assuming failure.');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-login-unknown.png') });
        return false;
    } catch (error) {
        logger.error('[😈 Daemon Login] ❌ Error during Twitter login:', error);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-login-exception.png') }).catch(()=>{}); // Best effort screenshot
        return false;
    }
}

/**
 * Loads processed mention IDs from the JSON file.
 * Creates the file if it doesn't exist.
 */
async function loadProcessedMentions(): Promise<Set<string>> {
    try {
        await fs.access(PROCESSED_MENTIONS_PATH);
        const data = await fs.readFile(PROCESSED_MENTIONS_PATH, 'utf-8');
        const ids: string[] = JSON.parse(data);
        logger.info(`[😈 Daemon] Loaded ${ids.length} processed mention IDs from ${PROCESSED_MENTIONS_PATH}.`);
        return new Set(ids);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            logger.info(`[😈 Daemon] ${PROCESSED_MENTIONS_PATH} not found. Creating a new one.`);
            await fs.writeFile(PROCESSED_MENTIONS_PATH, JSON.stringify([]));
            return new Set<string>();
        } else {
            logger.error('[😈 Daemon] Error loading processed mentions:', error);
            throw new Error('Failed to load processed mentions'); 
        }
    }
}

/**
 * Saves a mention ID to the processed mentions file.
 */
async function markMentionAsProcessed(mentionId: string, processedMentions: Set<string>): Promise<void> {
    if (processedMentions.has(mentionId)) {
        logger.debug(`[😈 Daemon] Mention ${mentionId} is already in the processed set.`);
        return;
     }

    processedMentions.add(mentionId);
    try {
        const idsArray = Array.from(processedMentions);
        await fs.writeFile(PROCESSED_MENTIONS_PATH, JSON.stringify(idsArray, null, 2));
        logger.debug(`[😈 Daemon] Marked mention ${mentionId} as processed and saved to file.`);
    } catch (error) {
        logger.error(`[😈 Daemon] Error saving processed mention ${mentionId} to ${PROCESSED_MENTIONS_PATH}:`, error);
        // Remove from the set in memory if save fails to allow retry on next poll
        processedMentions.delete(mentionId);
        logger.warn(`[😈 Daemon] Removed ${mentionId} from in-memory set due to save failure.`);
    }
}

/**
 * Extracts the first valid Twitter Space URL from text.
 * @param text The text to search within.
 * @returns The Space URL or null if not found.
 */
function extractSpaceUrl(text: string): string | null {
    const spaceUrlRegex = /https:\/\/(?:twitter|x)\.com\/i\/spaces\/([a-zA-Z0-9]+)/;
    const match = text.match(spaceUrlRegex);
    return match ? match[0] : null;
}

/**
 * Extracts the unique ID from a Twitter Space URL.
 * @param spaceUrl The URL like https://x.com/i/spaces/...
 * @returns The space ID string or null if not found.
 */
function extractSpaceId(spaceUrl: string): string | null {
    const spaceIdRegex = /spaces\/([a-zA-Z0-9]+)/;
    const match = spaceUrl.match(spaceIdRegex);
    return match ? match[1] : null;
}

/**
 * Main processing function for a single mention containing a Space URL.
 * Orchestrates the dubbing workflow using the provided page.
 * IMPORTANT: This function now assumes it has exclusive control over the page.
 */
async function processMentionRequest(
    mention: MentionInfo, 
    page: Page // Pass the shared page object
): Promise<void> {
    logger.info(`[🚀 Process] Starting processing for mention: ${mention.tweetId} from ${mention.username}`);
    const spaceUrl = extractSpaceUrl(mention.text);
    if (!spaceUrl) {
        logger.warn(`[🚀 Process ${mention.tweetId}] No space URL found in mention text. Skipping processing.`);
        return;
    }

    const spaceId = extractSpaceId(spaceUrl);
    if (!spaceId) {
        logger.warn(`[🚀 Process ${mention.tweetId}] Could not extract Space ID from URL: ${spaceUrl}. Skipping processing.`);
        return;
    }

    // Construct a unique name for the project and audio file
    const spaceName = `mention_${mention.tweetId}_${spaceId}`;
    const thirdPartyId = mention.tweetId; // Use mention ID for tracking status
    let publicAudioUrl: string | null = null;
    let projectId: string | null = null;
    let sharingLink: string | null = null;

    try {
        // Phase 2: Get M3U8
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 2: Getting M3U8 for ${spaceUrl}...`);
        const spaceInfo = await getM3u8ForSpacePage(spaceUrl, page); // Pass the shared page
        if (!spaceInfo || !spaceInfo.m3u8Url) {
            throw new Error('Failed to extract M3U8 URL from Space page.');
        }
        const m3u8Url = spaceInfo.m3u8Url;
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 2: Got M3U8 URL.`); // Don't log potentially sensitive URLs always
        logger.debug(`[🚀 Process ${mention.tweetId}] Phase 2: M3U8 URL: ${m3u8Url}`);

        // Phase 3: Download & Upload Audio
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 3: Downloading and uploading audio (SpaceName: ${spaceName})...`);
        publicAudioUrl = await downloadAndUploadAudio(m3u8Url, spaceName);
        if (!publicAudioUrl) {
            throw new Error('Failed to download and upload audio.');
        }
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 3: Audio uploaded to: ${publicAudioUrl}`);

        // Phase 4: Create Dubbing Project
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 4: Creating SpeechLab project (Name: ${spaceName})...`);
        projectId = await createDubbingProject(publicAudioUrl, spaceName);
        if (!projectId) {
            throw new Error('Failed to create SpeechLab dubbing project.');
        }
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 4: SpeechLab project created: ${projectId}`);

        // Phase 5: Wait for Completion
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 5: Waiting for project completion (thirdPartyID: ${thirdPartyId})...`);
        const completed = await waitForProjectCompletion(thirdPartyId);
        if (!completed) {
            throw new Error(`SpeechLab project did not complete successfully (thirdPartyID: ${thirdPartyId}).`);
        }
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 5: Project ${projectId} completed.`);

        // Phase 6: Generate Sharing Link
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 6: Generating sharing link for project ${projectId}...`);
        sharingLink = await generateSharingLink(projectId);
        if (!sharingLink) {
            throw new Error('Failed to generate SpeechLab sharing link.');
        }
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 6: Got sharing link: ${sharingLink}`);

        // Phase 7: Post Reply
        logger.info(`[🚀 Process ${mention.tweetId}] Phase 7: Posting reply to mention tweet ${mention.tweetUrl}...`);
        const replyText = `Hey ${mention.username}! Here is your dubbed version of the Space: ${sharingLink} #SpeechLabAI`;
        const replyPosted = await postReplyToTweet(page, mention.tweetUrl, replyText); // Pass the shared page
        if (!replyPosted) {
             // Log error but don't necessarily fail the whole process if reply fails
             logger.error(`[🚀 Process ${mention.tweetId}] Phase 7: Failed to post reply to ${mention.tweetUrl}.`);
        } else {
            logger.info(`[🚀 Process ${mention.tweetId}] Phase 7: ✅ Successfully posted reply.`);
        }

        logger.info(`[🚀 Process ${mention.tweetId}] ✅ Successfully processed mention.`);

    } catch (error) {
        logger.error(`[🚀 Process ${mention.tweetId}] ❌ Error during processing:`, error);
        // Consider posting an error reply? 
        // const errorReplyText = `Sorry ${mention.username}, I encountered an error trying to process that Space. Please try again later.`;
        // await postReplyToTweet(page, mention.tweetUrl, errorReplyText).catch(e => logger.error('Failed to post error reply', e));
    } finally {
         // Cleanup? Maybe remove downloaded audio file if needed
    }
}

// --- Queue Worker --- 
/**
 * Processes mentions from the queue one by one sequentially.
 */
async function runProcessingQueue(page: Page): Promise<void> {
    if (isProcessingQueue) {
        logger.debug('[⚙️ Queue] Processing already in progress. Skipping new worker start.');
        return; // Worker already running
    }

    isProcessingQueue = true;
    logger.info(`[⚙️ Queue] Starting processing worker. Queue size: ${mentionQueue.length}`);

    while (mentionQueue.length > 0) {
        const mentionToProcess = mentionQueue.shift(); // Get the next mention (FIFO)
        if (!mentionToProcess) continue; // Should not happen, but safety check

        logger.info(`[⚙️ Queue] Processing mention ${mentionToProcess.tweetId} from queue. Remaining: ${mentionQueue.length}`);
        
        // Ensure page is usable before processing
        if (!page || page.isClosed()) {
            logger.error(`[⚙️ Queue] Page is closed! Cannot process mention ${mentionToProcess.tweetId}. Stopping worker.`);
            mentionQueue.unshift(mentionToProcess); // Put it back for potential later retry if daemon recovers?
            isProcessingQueue = false;
            return; // Stop the worker if page dies
        }

        try {
            await processMentionRequest(mentionToProcess, page); // Process sequentially
        } catch (error) {
            // Log error from processMentionRequest itself, but continue the queue
            logger.error(`[⚙️ Queue] Error processing mention ${mentionToProcess.tweetId} from queue worker:`, error);
        }
        logger.info(`[⚙️ Queue] Finished processing mention ${mentionToProcess.tweetId}.`);
         // Optional: Add a small delay between processing tasks?
         // await page.waitForTimeout(1000);
    }

    isProcessingQueue = false;
    logger.info('[⚙️ Queue] Processing worker finished (queue empty).');
}
// --- END Queue Worker ---

// --- Main Daemon Logic ---
async function main() {
    logger.info('[😈 Daemon] Starting Mention Monitoring Daemon...');
    logger.info('[😈 Daemon] LOG_LEVEL set to: ' + config.LOG_LEVEL);
    
    // Set up more verbose logging if needed
    if (config.LOG_LEVEL === 'debug') {
        logger.info('[😈 Daemon] Debug logging enabled - will show detailed execution flow');
    }

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let processedMentions: Set<string>;
    let intervalId: NodeJS.Timeout | null = null; // Keep track of interval

    // Graceful shutdown handler
    const shutdown = async (signal: string) => {
        logger.info(`[😈 Daemon] Received ${signal}. Shutting down gracefully...`);
        if (intervalId) clearInterval(intervalId);
        intervalId = null; // Prevent further polling calls

        try {
            if (page && !page.isClosed()) {
                logger.info('[😈 Daemon] Closing Playwright page...');
                await page.close();
            }
        } catch (e) { logger.warn('[😈 Daemon] Error closing page during shutdown', e); }
        
        try {
            if (context) { // Check context before closing
                 logger.info('[😈 Daemon] Closing Playwright context...');
                 await context.close();
             }
        } catch (e) { logger.warn('[😈 Daemon] Error closing context during shutdown', e); }
        
        try {
             if (browser) { // Check browser before closing
                 logger.info('[😈 Daemon] Closing Playwright browser...');
                 await browser.close();
             }
        } catch (e) { logger.warn('[😈 Daemon] Error closing browser during shutdown', e); }
        
        logger.info('[😈 Daemon] Shutdown complete.');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    try {
        processedMentions = await loadProcessedMentions();

        logger.info('[😈 Daemon] Initializing browser and logging into Twitter...');
        const browserInfo = await initializeDaemonBrowser(); // Use copied function
        browser = browserInfo.browser;
        context = browserInfo.context;
        page = await context.newPage();
        
        // Print more diagnostic info before login
        logger.info('[😈 Daemon] Browser and context initialized successfully.');
        logger.info(`[😈 Daemon] Twitter credentials - Username: ${config.TWITTER_USERNAME ? '✓ Set' : '❌ Missing'}, Password: ${config.TWITTER_PASSWORD ? '✓ Set' : '❌ Missing'}`);

        // Try login with retries
        let loginSuccess = false;
        const MAX_LOGIN_ATTEMPTS = 3;
        
        for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
            logger.info(`[😈 Daemon] Login attempt ${attempt}/${MAX_LOGIN_ATTEMPTS}...`);
            loginSuccess = await loginToTwitterDaemon(page);
            
            if (loginSuccess) {
                logger.info(`[😈 Daemon] Login successful on attempt ${attempt}!`);
                break;
            } else if (attempt < MAX_LOGIN_ATTEMPTS) {
                logger.warn(`[😈 Daemon] Login attempt ${attempt} failed. Waiting 5 seconds before retry...`);
                await page.waitForTimeout(5000);
                
                // Try navigating back to login page for the next attempt
                try {
                    logger.info('[😈 Daemon] Navigating back to login page for retry...');
                    await page.goto('https://twitter.com/i/flow/login', { 
                        waitUntil: 'networkidle', 
                        timeout: 30000 
                    });
                } catch (navError) {
                    logger.error('[😈 Daemon] Error navigating to login page for retry:', navError);
                }
            }
        }
        
        if (!loginSuccess) {
            throw new Error(`Twitter login failed after ${MAX_LOGIN_ATTEMPTS} attempts. Daemon cannot continue.`);
        }
        
        logger.info('[😈 Daemon] Twitter login successful.');

        logger.info(`[😈 Daemon] Starting mention polling loop (Interval: ${POLLING_INTERVAL_MS / 1000}s)`);

        const pollMentions = async () => {
            // Check if shutdown has started
            if (intervalId === null) {
                logger.info('[😈 Daemon] Shutdown initiated, skipping poll cycle.');
                return; 
            }
             if (!page || page.isClosed()) {
                 logger.error('[😈 Daemon] Page is closed or null. Cannot poll. Attempting recovery may be needed or shutdown required.');
                // Consider stopping the interval or attempting recovery
                 if (intervalId) clearInterval(intervalId); 
                 intervalId = null;
                 throw new Error('Polling page closed unexpectedly'); // Let main catch block handle cleanup
             }
            logger.info('[😈 Daemon] Polling for new mentions...');
            try {
                // Use the page that should already be logged in
                const mentions = await scrapeMentions(page);
                logger.info(`[😈 Daemon] Scraped ${mentions.length} mentions from page.`);

                let newMentionsFound = 0;
                for (const mention of mentions) {
                    if (!processedMentions.has(mention.tweetId)) {
                        newMentionsFound++;
                        logger.info(`[🔔 Mention] Found new mention: ID=${mention.tweetId}, User=${mention.username}, Text="${mention.text.substring(0, 50)}..."`);
                        
                        const spaceUrl = extractSpaceUrl(mention.text);
                        
                        if (spaceUrl) {
                            logger.info(`[🔔 Mention]   Extracted Space URL: ${spaceUrl}. Adding to processing queue.`);
                            // Trigger the processing workflow (asynchronously)
                            // Make sure the page object is valid before passing
                             // ADD TO QUEUE instead of calling directly
                             mentionQueue.push(mention);
                             logger.info(`[⚙️ Queue] Mention ${mention.tweetId} added. Queue size: ${mentionQueue.length}`);
                             // Trigger the queue worker if it's not already running
                             if (page && !page.isClosed() && !isProcessingQueue) {
                                 runProcessingQueue(page).catch(err => {
                                      logger.error('[😈 Daemon] Unhandled error in queue worker execution:', err);
                                      isProcessingQueue = false; // Ensure flag is reset on error
                                  }); 
                             } else if (!page || page.isClosed()) {
                                 logger.error('[😈 Daemon] Page is closed, cannot start queue worker.');
                             }
                             
                             // Mark as processed immediately only if processing was *started*
                             // Decision: Mark as processed *after* successful processing? Or when added to queue?
                             // Let's mark when added to queue to prevent retries if daemon restarts.
                             await markMentionAsProcessed(mention.tweetId, processedMentions);
                        } else {
                            logger.info(`[🔔 Mention]   No Twitter Space URL found in mention text. Marking as processed & skipping.`);
                            // Mark non-space mentions as processed to avoid re-checking
                             await markMentionAsProcessed(mention.tweetId, processedMentions);
                        }
                    } else {
                        // logger.debug(`[🔔 Mention] Skipping already processed mention: ID=${mention.tweetId}`);
                    }
                }
                 if (newMentionsFound === 0) {
                    logger.info('[😈 Daemon] No new mentions found in this poll.');
                }

            } catch (error) {
                logger.error('[😈 Daemon] Error during mention polling cycle:', error);
                 if (page?.isClosed()) {
                     logger.error('[😈 Daemon] Page closed during polling error. Stopping interval.');
                     if (intervalId) clearInterval(intervalId); 
                     intervalId = null;
                     throw error; // Let main catch handle shutdown
                 } else if (page) {
                     logger.warn('[😈 Daemon] Attempting to recover page state after polling error...');
                     try {
                         await page.goto('https://twitter.com/home', { waitUntil: 'networkidle', timeout: 30000 });
                         logger.info('[😈 Daemon] Recovered page state by navigating home.');
                     } catch (recoveryError) {
                         logger.error('[😈 Daemon] Failed to recover page state after error:', recoveryError);
                         if (intervalId) clearInterval(intervalId); 
                         intervalId = null;
                         throw new Error('Failed to recover polling page'); // Let main catch handle shutdown
                     }
                 }
            }
        };

        await pollMentions(); 
        intervalId = setInterval(pollMentions, POLLING_INTERVAL_MS);

        logger.info('[😈 Daemon] Daemon initialization complete. Monitoring mentions...');

    } catch (error) {
        logger.error('[😈 Daemon] Daemon encountered fatal error during initialization or polling:', error);
        // Ensure cleanup happens on fatal error
        if (intervalId) clearInterval(intervalId); 
        try {
             if (page && !page.isClosed()) await page.close(); 
        } catch (e) { logger.warn('[😈 Daemon] Error closing page on fatal error', e); }
         try {
             if (context) await context.close(); 
        } catch (e) { logger.warn('[😈 Daemon] Error closing context on fatal error', e); }
         try {
             if (browser) await browser.close(); 
        } catch (e) { logger.warn('[😈 Daemon] Error closing browser on fatal error', e); }
        process.exit(1);
    }

     // Keep alive only if interval is running
     if (intervalId) {
         await new Promise(() => {}); // Keep alive indefinitely
     } else {
          logger.info('[😈 Daemon] Interval timer not set or cleared. Exiting.');
          process.exit(0); // Exit if polling stopped
     }
}

main(); 