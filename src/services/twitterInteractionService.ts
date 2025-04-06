import { chromium, Browser, Page, BrowserContext, Locator } from 'playwright';
import logger from '../utils/logger';
import { config } from '../utils/config'; // For potential credentials later
import * as path from 'path'; // Added import for path module

// Define the expected structure for the result
export interface SpaceInfo {
    originalTweetUrl: string;
    m3u8Url: string;
    spaceName: string | null; // Name might not always be easily extractable
}

// Selectors - **Highly likely to change based on Twitter UI updates**
// These are placeholders and need careful inspection and testing on the live site.
const TWEET_SELECTOR = 'article[data-testid="tweet"]'; // General tweet container
const SPACE_CARD_SELECTOR = 'div[data-testid="card.wrapper"]'; // Selector for the card within a tweet
const PLAY_RECORDING_BUTTON_SELECTOR = 'button[aria-label*="Play recording"], button:has-text("Play recording")'; // Example selectors for the button
const SPACE_TITLE_SELECTOR = 'div[data-testid="card.layoutLarge.media"] + div span'; // Highly speculative selector for title
const TWEET_TIME_LINK_SELECTOR = 'time'; // Used to find ancestor link for tweet URL

// --- Selectors for postReplyToTweet --- (VERY LIKELY TO CHANGE)
// Button to open the reply composer for a specific tweet
const TWEET_REPLY_BUTTON_SELECTOR = 'button[data-testid="reply"]';
// The main text area for composing the reply (might appear after clicking reply button)
const REPLY_TEXT_AREA_SELECTOR = 'div[data-testid="tweetTextarea_0"]';
// The button to submit the reply
const POST_REPLY_BUTTON_SELECTOR = 'button[data-testid="tweetButton"]'; // Or sometimes "tweetButtonInline"

// --- Selectors for Space Page (Need Verification) ---
const SPACE_PAGE_PLAY_BUTTON_SELECTOR = 'button[aria-label*="Play recording"], button:has-text("Play recording")';
const LINK_TO_ORIGINAL_TWEET_SELECTOR = 'a:has-text("View on X"), a[href*="/status/"]'; // Highly speculative

/**
 * Logs into Twitter using provided credentials.
 * @param page The Playwright page to use
 * @returns {Promise<boolean>} Success status of login
 */
async function loginToTwitter(page: Page): Promise<boolean> {
    const username = config.TWITTER_USERNAME;
    const password = config.TWITTER_PASSWORD;
    
    if (!username || !password) {
        logger.error('[🐦 Twitter] Cannot login: Twitter credentials are missing in environment variables');
        logger.error('[🐦 Twitter] Make sure TWITTER_USERNAME and TWITTER_PASSWORD are set in your .env file');
        return false;
    }
    
    logger.info(`[🐦 Twitter] Attempting to login to Twitter with username: ${username}...`);
    
    try {
        // Navigate to login page
        logger.debug('[🐦 Twitter] Navigating to Twitter login page...');
        await page.goto('https://twitter.com/i/flow/login', { waitUntil: 'networkidle', timeout: 60000 });
        logger.debug('[🐦 Twitter] Login page loaded');
        
        // Take screenshot of login page
        await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'login-page.png') });
        
        // Wait a moment for the page to stabilize
        await page.waitForTimeout(3000);
        
        // Try multiple selectors for username field
        logger.debug('[🐦 Twitter] Attempting to find and fill the username field...');
        
        // Try various common selectors for the username field
        const usernameSelectors = [
            'input[autocomplete="username"]',
            'input[name="text"]',
            'input[type="text"]',
            '[data-testid="username_or_email"]'
        ];
        
        let usernameField = null;
        for (const selector of usernameSelectors) {
            logger.debug(`[🐦 Twitter] Trying username selector: ${selector}`);
            const field = page.locator(selector).first();
            if (await field.isVisible({ timeout: 1000 }).catch(() => false)) {
                usernameField = field;
                logger.debug(`[🐦 Twitter] Found username field with selector: ${selector}`);
                break;
            }
        }
        
        if (!usernameField) {
            logger.error('[🐦 Twitter] Could not find username field. Taking screenshot of current state...');
            await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'no-username-field.png') });
            
            // Log all input fields for debugging
            const inputFields = await page.locator('input').all();
            logger.debug(`[🐦 Twitter] Found ${inputFields.length} input fields on page:`);
            for (let i = 0; i < inputFields.length; i++) {
                const type = await inputFields[i].getAttribute('type') || 'unknown';
                const name = await inputFields[i].getAttribute('name') || 'unknown';
                const id = await inputFields[i].getAttribute('id') || 'unknown';
                logger.debug(`[🐦 Twitter] Input ${i+1}: type="${type}", name="${name}", id="${id}"`);
            }
            
            throw new Error('Username field not found');
        }
        
        // Fill username and click Next
        logger.debug(`[🐦 Twitter] Filling username field with: ${username}`);
        await usernameField.fill(username);
        await page.waitForTimeout(1000); // Wait a moment after filling
        
        // Look for the "Next" button
        const nextButtonSelectors = [
            '[data-testid="LoginForm_Login_Button"]',
            'div[role="button"]:has-text("Next")',
            'button:has-text("Next")',
            '[data-testid="login-primary-button"]'
        ];
        
        let nextButton = null;
        for (const selector of nextButtonSelectors) {
            logger.debug(`[🐦 Twitter] Trying next button selector: ${selector}`);
            const button = page.locator(selector).first();
            if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
                nextButton = button;
                logger.debug(`[🐦 Twitter] Found next button with selector: ${selector}`);
                break;
            }
        }
        
        if (!nextButton) {
            logger.error('[🐦 Twitter] Could not find Next button. Taking screenshot...');
            await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'no-next-button.png') });
            throw new Error('Next button not found');
        }
        
        logger.debug('[🐦 Twitter] Clicking Next button...');
        await nextButton.click();
        await page.waitForTimeout(3000); // Wait for next screen
        
        // Take screenshot after username entry
        await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'after-username.png') });
        
        // Check if we need verification (unusual login detection)
        const verificationSelectors = [
            'input[data-testid="ocfEnterTextTextInput"]',
            'input[name="text"]:not([value])',
            'input[placeholder*="phone"]'
        ];
        
        for (const selector of verificationSelectors) {
            const verifyField = page.locator(selector).first();
            if (await verifyField.isVisible({ timeout: 1000 }).catch(() => false)) {
                logger.info('[🐦 Twitter] Verification step detected. Taking screenshot...');
                await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'verification-request.png') });
                logger.info('[🐦 Twitter] If you are seeing verification requests, you may need to manually login first');
                throw new Error('Twitter requested verification - manual login may be required first');
            }
        }
        
        // Look for password field
        logger.debug('[🐦 Twitter] Looking for password field...');
        const passwordSelectors = [
            'input[name="password"]',
            'input[type="password"]',
            '[data-testid="password"]'
        ];
        
        let passwordField = null;
        for (const selector of passwordSelectors) {
            logger.debug(`[🐦 Twitter] Trying password selector: ${selector}`);
            const field = page.locator(selector).first();
            if (await field.isVisible({ timeout: 1000 }).catch(() => false)) {
                passwordField = field;
                logger.debug(`[🐦 Twitter] Found password field with selector: ${selector}`);
                break;
            }
        }
        
        if (!passwordField) {
            logger.error('[🐦 Twitter] Could not find password field. Taking screenshot...');
            await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'no-password-field.png') });
            throw new Error('Password field not found');
        }
        
        // Fill password
        logger.debug('[🐦 Twitter] Filling password field');
        await passwordField.fill(password);
        await page.waitForTimeout(1000);
        
        // Look for login button
        const loginButtonSelectors = [
            '[data-testid="LoginForm_Login_Button"]',
            'div[role="button"]:has-text("Log in")',
            'button:has-text("Log in")',
            '[data-testid="login-primary-button"]'
        ];
        
        let loginButton = null;
        for (const selector of loginButtonSelectors) {
            logger.debug(`[🐦 Twitter] Trying login button selector: ${selector}`);
            const button = page.locator(selector).first();
            if (await button.isVisible({ timeout: 1000 }).catch(() => false)) {
                loginButton = button;
                logger.debug(`[🐦 Twitter] Found login button with selector: ${selector}`);
                break;
            }
        }
        
        if (!loginButton) {
            logger.error('[🐦 Twitter] Could not find Login button. Taking screenshot...');
            await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'no-login-button.png') });
            throw new Error('Login button not found');
        }
        
        logger.debug('[🐦 Twitter] Clicking Login button...');
        await loginButton.click();
        
        // Wait for navigation to complete after login
        logger.debug('[🐦 Twitter] Waiting for login to complete...');
        await page.waitForTimeout(5000);
        await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'after-login-attempt.png') });
        
        // Check for some elements that would indicate successful login
        const successIndicators = [
            '[data-testid="primaryColumn"]',
            '[data-testid="AppTabBar_Home_Link"]',
            '[data-testid="SideNav_NewTweet_Button"]',
            'a[href="/home"]',
            'a[aria-label="Profile"]'
        ];
        
        for (const selector of successIndicators) {
            const indicator = page.locator(selector).first();
            if (await indicator.isVisible({ timeout: 1000 }).catch(() => false)) {
                logger.info('[🐦 Twitter] ✅ Successfully logged in to Twitter');
                await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'login-success.png') });
                return true;
            }
        }
        
        // Check for error messages
        const errorSelectors = [
            'div[data-testid="toast"]',
            'div[role="alert"]',
            'span:has-text("Wrong username or password")',
            'span:has-text("The username and password you entered did not match our records")'
        ];
        
        for (const selector of errorSelectors) {
            const errorElem = page.locator(selector).first();
            if (await errorElem.isVisible({ timeout: 1000 }).catch(() => false)) {
                const errorText = await errorElem.textContent() || 'Unknown error';
                logger.error(`[🐦 Twitter] Login error detected: ${errorText}`);
                await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'login-error.png') });
                throw new Error(`Twitter login failed with error: ${errorText}`);
            }
        }
        
        logger.warn('[🐦 Twitter] Could not confirm login success or failure. Taking screenshot...');
        await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'login-unknown-state.png') });
        return false;
    } catch (error) {
        logger.error('[🐦 Twitter] ❌ Error during Twitter login:', error);
        return false;
    }
}

/**
 * Initializes a Playwright browser instance and context.
 * Consider persisting context for login state if needed later.
 */
async function initializeBrowser(): Promise<{ browser: Browser, context: BrowserContext }> {
    logger.info('[🐦 Twitter] Initializing Playwright browser...');
    // Use non-headless mode for debugging
    const browser = await chromium.launch({ 
        headless: false, // Run in non-headless mode for debugging
        slowMo: 250 // Add slight delay between actions for better visibility
    });
    const context = await browser.newContext({
        // Emulate a common user agent
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        // Viewport size can influence page layout - larger for better visibility
        viewport: { width: 1366, height: 900 },
        // Locale might influence language/selectors
        locale: 'en-US'
    });

    // Optional: Add cookie handling here if login persistence is implemented
    logger.info('[🐦 Twitter] ✅ Browser initialized in non-headless mode for debugging.');
    return { browser, context };
}

/**
 * Finds the latest tweet with a recorded Space on a given profile URL
 * and extracts the m3u8 URL by intercepting network requests after clicking 'Play recording'.
 *
 * @param profileUrl The URL of the Twitter profile to scan.
 * @returns {Promise<SpaceInfo | null>} SpaceInfo object if found, otherwise null.
 */
export async function findLatestRecordedSpaceAndM3u8(profileUrl: string): Promise<SpaceInfo | null> {
    logger.info(`[🐦 Twitter] Starting search for recorded Space on profile: ${profileUrl}`);
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let capturedM3u8Url: string | null = null;
    let foundOriginalTweetUrl: string | null = null; // Renamed for clarity
    let foundSpaceName: string | null = null; // Renamed for clarity

    let resolveM3u8Promise: (url: string) => void;
    let m3u8Promise = new Promise<string>((resolve) => { // Re-initialize promise inside the loop if needed
        resolveM3u8Promise = resolve;
    });

    try {
        const browserInfo = await initializeBrowser();
        browser = browserInfo.browser;
        context = browserInfo.context;
        page = await context.newPage();

        // Network Interception Setup
        logger.debug('[🐦 Twitter] Setting up network interception for M3U8...');
        await page.route(
            (url) => url.hostname.endsWith('pscp.tv') && url.pathname.includes('playlist_') && url.pathname.endsWith('.m3u8'),
            (route, request) => {
                const url = request.url();
                logger.info(`[🐦 Twitter] ✅ Intercepted M3U8 URL: ${url}`);
                if (!capturedM3u8Url) {
                    capturedM3u8Url = url;
                    resolveM3u8Promise(url); // Resolve the currently active promise
                }
                route.continue();
            }
        );
        page.on('request', request => {
            const url = request.url();
            if (!capturedM3u8Url && url.includes('pscp.tv') && url.includes('playlist_') && url.includes('.m3u8')) {
                logger.info(`[🐦 Twitter] ✅ Captured M3U8 URL via listener: ${url}`);
                capturedM3u8Url = url;
                if (resolveM3u8Promise) {
                    resolveM3u8Promise(url);
                }
            }
        });

        logger.info(`[🐦 Twitter] Navigating to profile: ${profileUrl}`);
        await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 60000 });
        logger.info('[🐦 Twitter] Navigation complete. Searching for tweets...');

        // Scroll and Find Tweet
        for (let i = 0; i < 5; i++) {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(2000);
            logger.debug(`[🐦 Twitter] Scrolled down (${i + 1}/5)`);
        }

        logger.debug('[🐦 Twitter] Finding potential Space tweets...');
        const tweets = await page.locator(TWEET_SELECTOR).all();
        logger.debug(`[🐦 Twitter] Found ${tweets.length} tweets. Filtering for Spaces with recordings...`);

        let spaceFoundAndProcessed = false;
        for (let i = tweets.length - 1; i >= 0; i--) {
            const tweet = tweets[i];
            const spaceCard = tweet.locator(SPACE_CARD_SELECTOR);
            const playButton = spaceCard.locator(PLAY_RECORDING_BUTTON_SELECTOR);

            // Added short timeouts to visibility checks to prevent hanging
            if (await spaceCard.isVisible({ timeout: 1000 }) && await playButton.isVisible({ timeout: 1000 })) {
                logger.info(`[🐦 Twitter] Found potential recorded Space tweet (index ${i}). Attempting to process...`);

                let currentTweetUrl: string | null = null;
                let currentSpaceName: string | null = null;

                // Extract tweet URL for this specific tweet
                try {
                    const timeElement = tweet.locator(TWEET_TIME_LINK_SELECTOR).first();
                    const linkElement = timeElement.locator('xpath=./ancestor::a');
                    const href = await linkElement.getAttribute('href', { timeout: 5000 });
                    if (href) {
                        currentTweetUrl = `https://x.com${href}`;
                        logger.debug(`[🐦 Twitter] Extracted potential tweet URL: ${currentTweetUrl}`);
                    } else {
                        logger.warn('[🐦 Twitter] Could not extract tweet href using time element method for this tweet.');
                    }
                } catch (linkError) {
                    logger.warn('[🐦 Twitter] Error extracting tweet URL for this tweet:', linkError);
                }

                // Extract Space Name for this specific tweet
                try {
                    const titleElement = spaceCard.locator(SPACE_TITLE_SELECTOR).first();
                    if (await titleElement.isVisible({ timeout: 1000 })) {
                        currentSpaceName = await titleElement.textContent({ timeout: 5000 });
                        logger.debug(`[🐦 Twitter] Attempted to extract potential Space Name: ${currentSpaceName}`);
                    }
                } catch (titleError) {
                    logger.warn('[🐦 Twitter] Could not extract space name for this tweet.');
                }

                // Reset promise and captured URL before attempting click and capture
                capturedM3u8Url = null;
                m3u8Promise = new Promise<string>((resolve) => { resolveM3u8Promise = resolve; });

                logger.info('[🐦 Twitter] Clicking "Play recording" button for this tweet...');
                const clickPromise = playButton.click({ timeout: 10000 });
                const m3u8WaitPromise = new Promise<string>((resolve, reject) => {
                    const timeoutId = setTimeout(() => reject(new Error('M3U8 capture timeout (20s)')), 20000);
                    m3u8Promise.then(url => {
                        clearTimeout(timeoutId);
                        resolve(url);
                    }).catch(reject); // Propagate rejection if m3u8Promise itself rejects
                });

                try {
                    await clickPromise; // Ensure click action is attempted
                    logger.debug('[🐦 Twitter] Button clicked. Waiting for M3U8 network request...');
                    await m3u8WaitPromise; // Wait specifically for the M3U8 URL capture

                    if (capturedM3u8Url && currentTweetUrl) {
                        logger.info('[🐦 Twitter] ✅ Successfully captured M3U8 URL and have Tweet URL.');
                        foundOriginalTweetUrl = currentTweetUrl;
                        foundSpaceName = currentSpaceName;
                        spaceFoundAndProcessed = true;
                        break; // --- Exit loop: Successfully processed the latest recorded space --- 
                    } else if (capturedM3u8Url) {
                        logger.warn('[🐦 Twitter] M3U8 captured but failed to get the specific tweet URL for this instance.');
                        // Reset M3U8 url because we can't link it to a tweet
                        capturedM3u8Url = null;
                    } else {
                        logger.warn('[🐦 Twitter] M3U8 promise resolved without URL or tweet URL missing.');
                    }
                } catch (waitError) {
                    logger.warn(`[🐦 Twitter] Error or timeout clicking/waiting for M3U8 for tweet (index ${i}):`, waitError);
                    // Reset captured URL, continue searching older tweets
                    capturedM3u8Url = null;
                }
            }
            // Add a small delay before checking the next older tweet
            if (!spaceFoundAndProcessed) {
                await page.waitForTimeout(200);
            }
        }

        // Check results after the loop
        if (!spaceFoundAndProcessed || !capturedM3u8Url || !foundOriginalTweetUrl) {
            logger.warn(`[🐦 Twitter] Failed to find/process recorded Space with M3U8/Tweet URL for ${profileUrl}.`);
            return null;
        }

        logger.info(`[🐦 Twitter] ✅ Found Space Info for ${profileUrl}`);
        return {
            originalTweetUrl: foundOriginalTweetUrl,
            m3u8Url: capturedM3u8Url,
            spaceName: foundSpaceName
        };

    } catch (error) {
        logger.error(`[🐦 Twitter] ❌ Error processing profile ${profileUrl} in findLatestRecordedSpaceAndM3u8:`, error);
        return null;
    } finally {
        logger.debug('[🐦 Twitter] Cleaning up browser instance (findLatest)...');
        if (page && !page.isClosed()) await page.close().catch(e => logger.warn('[🐦 Twitter] Error closing page (findLatest)', e));
        if (context) await context.close().catch(e => logger.warn('[🐦 Twitter] Error closing context (findLatest)', e));
        if (browser) await browser.close().catch(e => logger.warn('[🐦 Twitter] Error closing browser (findLatest)', e));
        logger.debug('[🐦 Twitter] Browser cleanup complete (findLatest).');
    }
}

/**
 * Navigates to a direct Twitter Space URL, clicks Play, and intercepts the M3U8 network request.
 * Also attempts (best-effort) to find a link back to the original tweet.
 *
 * @param directSpaceUrl The URL like https://x.com/i/spaces/...
 * @returns Promise resolving with M3U8 URL and potentially the original Tweet URL.
 */
export async function getM3u8ForSpacePage(directSpaceUrl: string): Promise<{ m3u8Url: string | null, originalTweetUrl: string | null }> {
    logger.info(`[🐦 Twitter] Starting direct Space URL processing: ${directSpaceUrl}`);
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let capturedM3u8Url: string | null = null;
    let foundOriginalTweetUrl: string | null = null;

    // Create a log of all network requests for debugging
    const networkRequests: string[] = [];
    
    let resolveM3u8Promise: (url: string) => void;
    const m3u8Promise = new Promise<string>((resolve) => {
        resolveM3u8Promise = resolve;
    });

    try {
        // Initialize browser in NON-headless mode for debugging
        logger.info('[🐦 Twitter] Starting browser in non-headless mode for Space URL processing...');
        browser = await chromium.launch({ 
            headless: false, // Non-headless mode 
            slowMo: 250 // Slow down actions for visibility during debugging
        });
        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 900 },
            locale: 'en-US'
        });
        page = await context.newPage();

        // Take screenshots to help with debugging
        const screenshotDir = path.join(process.cwd(), 'debug-screenshots');
        // Create directory if it doesn't exist
        const fs = require('fs');
        if (!fs.existsSync(screenshotDir)){
            fs.mkdirSync(screenshotDir, { recursive: true });
        }

        // Log all network requests - this will help us figure out what's happening
        page.on('request', request => {
            const url = request.url();
            networkRequests.push(`${request.method()} ${url}`);
            
            // Log when we see media files or playlist requests
            if (url.includes('.m3u8') || url.includes('playlist') || url.includes('media') || 
                url.includes('audio') || url.includes('video') || url.includes('pscp.tv')) {
                logger.debug(`[🐦 Twitter] 🔍 Network request: ${request.method()} ${url}`);
            }

            // Check for potential M3U8 URLs with broader patterns
            if ((url.includes('.m3u8') || url.includes('playlist')) && 
                (url.includes('pscp.tv') || url.includes('periscope') || url.includes('video'))) {
                logger.info(`[🐦 Twitter] ✅ Potential M3U8 URL detected: ${url}`);
                if (!capturedM3u8Url) {
                    capturedM3u8Url = url;
                    resolveM3u8Promise(url);
                }
            }
        });

        // Also capture responses to see content types
        page.on('response', async (response) => {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';
            
            // Log media responses
            if (contentType.includes('audio') || contentType.includes('video') || 
                contentType.includes('application/vnd.apple.mpegurl') || 
                contentType.includes('application/octet-stream') ||
                url.includes('.m3u8')) {
                logger.debug(`[🐦 Twitter] 📡 Media Response: ${url} (${contentType})`);
                
                // Check if this could be an M3U8 by content type
                if (contentType.includes('vnd.apple.mpegurl') || url.includes('.m3u8')) {
                    logger.info(`[🐦 Twitter] ✅ Potential M3U8 response by content-type: ${url}`);
                    if (!capturedM3u8Url) {
                        capturedM3u8Url = url;
                        resolveM3u8Promise(url);
                    }
                }
            }
        });

        // Network Interception with broader pattern matching
        logger.debug('[🐦 Twitter] Setting up network interception for M3U8...');
        await page.route(
            // Expanded pattern matching to catch more potential M3U8 URLs
            (url) => url.hostname.includes('pscp.tv') || 
                     url.hostname.includes('periscope') ||
                     (url.pathname.includes('.m3u8') || url.pathname.includes('playlist')),
            (route, request) => {
                const url = request.url();
                logger.info(`[🐦 Twitter] ✅ Intercepted potential media URL: ${url}`);
                if (!capturedM3u8Url && 
                    (url.includes('.m3u8') || url.includes('playlist'))) {
                    capturedM3u8Url = url;
                    resolveM3u8Promise(url);
                }
                route.continue();
            }
        );

        // LOGIN FIRST - Critical step to ensure we can access the space content
        const loginSuccess = await loginToTwitter(page);
        if (!loginSuccess) {
            logger.error('[🐦 Twitter] ❌ Failed to login to Twitter. Cannot proceed with space processing.');
            return { m3u8Url: null, originalTweetUrl: null };
        }

        // Now that we're logged in, navigate to space URL
        logger.info(`[🐦 Twitter] Navigating to space URL: ${directSpaceUrl}`);
        await page.goto(directSpaceUrl, { waitUntil: 'networkidle', timeout: 60000 });
        logger.info('[🐦 Twitter] Space page loaded. Taking initial screenshot...');
        await page.screenshot({ path: path.join(screenshotDir, 'space-page-loaded.png') });
        
        // Find and click the Play button on the space page - with a shorter timeout
        const playButton = page.locator(SPACE_PAGE_PLAY_BUTTON_SELECTOR).first();
        
        // Use a shorter timeout to fail faster if the button doesn't exist
        logger.info('[🐦 Twitter] Looking for "Play recording" button (with 10s timeout)...');
        const buttonVisible = await playButton.isVisible({ timeout: 10000 }).catch(() => false);
        
        if (!buttonVisible) {
            logger.warn('[🐦 Twitter] Play recording button not found within timeout - this may not be a valid recorded Space');
            await page.screenshot({ path: path.join(screenshotDir, 'no-play-button-found.png') });
            return { m3u8Url: null, originalTweetUrl: null };
        }
        
        // Button found, proceed with clicking it
        logger.info('[🐦 Twitter] "Play recording" button found. Clicking...');
        await playButton.click({ timeout: 10000 });
        
        // Take a screenshot after clicking the button
        await page.screenshot({ path: path.join(screenshotDir, 'after-play-button-click.png') });
        
        // Clear network requests list and start collecting for the post-click period
        networkRequests.length = 0;

        // Wait for the M3U8 URL to be captured
        logger.debug('[🐦 Twitter] Waiting for M3U8 network request...');
        try {
            // Use a reasonable timeout for M3U8 capture
            const m3u8CapturePromise = new Promise<string>((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    // Dump all network requests to the log to help debug
                    logger.info(`[🐦 Twitter] 📊 Network activity after clicking Play (${networkRequests.length} requests):`);
                    networkRequests.forEach((req, i) => {
                        logger.info(`[🐦 Twitter] Request ${i+1}: ${req}`);
                    });
                    
                    // Take another screenshot before failing - only if page still exists
                    if (page) {
                        page.screenshot({ path: path.join(screenshotDir, 'before-m3u8-timeout.png') })
                            .then(() => {
                                reject(new Error('M3U8 capture timeout (15s)'));
                            })
                            .catch(() => {
                                reject(new Error('M3U8 capture timeout (15s) - also failed to take screenshot'));
                            });
                    } else {
                        reject(new Error('M3U8 capture timeout (15s) - page no longer available'));
                    }
                }, 15000);
                
                m3u8Promise.then(url => {
                    clearTimeout(timeoutId);
                    resolve(url);
                });
            });
            
            await m3u8CapturePromise;
            
            if (!capturedM3u8Url) {
                throw new Error("M3U8 URL not captured before timeout.");
            }
            logger.info('[🐦 Twitter] ✅ Successfully captured M3U8 URL.');
        } catch (waitError) {
            logger.error('[🐦 Twitter] ❌ Error or timeout waiting for M3U8 request:', waitError);
            await page.screenshot({ path: path.join(screenshotDir, 'failed-m3u8-capture.png') });
            
            // Try to find links to tweet on the page before returning null
            try {
                const tweetLinkLocator = page.locator(LINK_TO_ORIGINAL_TWEET_SELECTOR).first();
                if (await tweetLinkLocator.isVisible({ timeout: 2000 })) {
                    foundOriginalTweetUrl = await tweetLinkLocator.getAttribute('href', { timeout: 2000 });
                    logger.info(`[🐦 Twitter] Found a potential original tweet URL despite M3U8 failure: ${foundOriginalTweetUrl}`);
                }
            } catch (linkError) {
                logger.warn('[🐦 Twitter] Additionally failed to extract original tweet URL:', linkError);
            }
            
            // No m3u8 captured, return null for it
            return { m3u8Url: null, originalTweetUrl: foundOriginalTweetUrl };
        }

        return { m3u8Url: capturedM3u8Url, originalTweetUrl: foundOriginalTweetUrl };

    } catch (error) {
        logger.error(`[🐦 Twitter] ❌ Error processing direct space URL ${directSpaceUrl}:`, error);
        return { m3u8Url: null, originalTweetUrl: null }; // Return nulls on failure
    } finally {
        logger.debug('[🐦 Twitter] Cleaning up browser instance (getM3u8ForSpacePage)...');
        if (page && !page.isClosed()) await page.close().catch(e => logger.warn('[🐦 Twitter] Error closing page', e));
        if (context) await context.close().catch(e => logger.warn('[🐦 Twitter] Error closing context', e));
        if (browser) await browser.close().catch(e => logger.warn('[🐦 Twitter] Error closing browser', e));
        logger.debug('[🐦 Twitter] Browser cleanup complete (getM3u8ForSpacePage).');
    }
}

/**
 * Posts a reply to a given tweet URL using Playwright.
 * NOTE: This requires the browser to be able to interact with Twitter,
 * potentially requiring a logged-in state. Selectors are fragile.
 *
 * @param tweetUrl The URL of the tweet to reply to.
 * @param commentText The text content of the reply.
 * @returns {Promise<boolean>} True if successful, false otherwise.
 */
export async function postReplyToTweet(tweetUrl: string, commentText: string): Promise<boolean> {
    logger.info(`[🐦 Twitter] Attempting to post reply to: ${tweetUrl}`);
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
        // Initialize a new browser instance for this action.
        // TODO: Refactor to reuse browser context if login state is needed and managed globally.
        const browserInfo = await initializeBrowser();
        browser = browserInfo.browser;
        context = browserInfo.context;
        // TODO: Implement loading cookies here if login is managed
        page = await context.newPage();

        logger.info(`[🐦 Twitter] Navigating to tweet: ${tweetUrl}`);
        await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }); // Use domcontentloaded for faster nav
        logger.info('[🐦 Twitter] Navigation complete. Locating reply elements...');

        // --- Locate Target Tweet and Reply Button --- 
        // Find the specific tweet article. Use the last part of the URL (status ID).
        const statusId = tweetUrl.split('/').pop();
        if (!statusId) {
            throw new Error('Could not extract status ID from tweet URL');
        }
        // More specific selector targeting the main tweet article on the page
        const targetTweetSelector = `article:has(a[href*="${statusId}"])`;
        const targetTweetLocator = page.locator(targetTweetSelector).first(); 
        await targetTweetLocator.waitFor({ state: 'visible', timeout: 20000 });
        logger.debug('[🐦 Twitter] Target tweet article located.');

        // Find the reply button *within* that specific tweet context
        const replyButton: Locator = targetTweetLocator.locator(TWEET_REPLY_BUTTON_SELECTOR).first();

        logger.debug('[🐦 Twitter] Attempting to click reply button for target tweet...');
        await replyButton.waitFor({ state: 'visible', timeout: 15000 });
        await replyButton.click();
        logger.debug('[🐦 Twitter] Reply button clicked. Waiting for reply composer...');

        // --- Interact with Reply Composer ---
        // The reply composer might be in a modal or inline. Wait for the text area.
        const textArea: Locator = page.locator(REPLY_TEXT_AREA_SELECTOR).first();
        await textArea.waitFor({ state: 'visible', timeout: 15000 }); // Increased timeout
        logger.debug('[🐦 Twitter] Reply text area located. Typing comment...');
        await textArea.fill(commentText);
        await page.waitForTimeout(500); // Short delay after typing

        // Find and click the Post/Reply button (usually within the composer context)
        const postButton: Locator = page.locator(POST_REPLY_BUTTON_SELECTOR).last(); // Often the last button with this testid
        await postButton.waitFor({ state: 'visible', timeout: 10000 });
        logger.debug('[🐦 Twitter] Post button located. Checking if enabled...');

        if (await postButton.isDisabled({ timeout: 5000 })) {
            logger.warn('[🐦 Twitter] Post button is disabled. Waiting briefly...');
            await page.waitForTimeout(3000); // Wait a bit longer
            if (await postButton.isDisabled({ timeout: 5000 })) {
                throw new Error('Post reply button remained disabled after wait.');
            }
            logger.debug('[🐦 Twitter] Post button became enabled.');
        }

        logger.debug('[🐦 Twitter] Clicking post reply button...');
        await postButton.click();

        // --- Verification (Basic) ---
        // Wait for a short period, assuming the post goes through if no immediate error.
        // Robust check would involve looking for the reply appearing, but that's complex.
        await page.waitForTimeout(5000); 

        logger.info(`[🐦 Twitter] ✅ Successfully posted reply to ${tweetUrl} (assumed based on successful clicks).`);
        return true;
    } catch (error) {
        logger.error(`[🐦 Twitter] ❌ Failed to post reply to ${tweetUrl}:`, error);
        if (page) {
            const screenshotPath = path.join(process.cwd(), `error_reply_screenshot_${Date.now()}.png`); // Save in root
            try {
                await page.screenshot({ path: screenshotPath, fullPage: true });
                logger.info(`[🐦 Twitter] Screenshot saved to ${screenshotPath}`);
            } catch (ssError) {
                logger.error('[🐦 Twitter] Failed to take error screenshot:', ssError);
            }
        }
        return false;
    } finally {
        logger.debug('[🐦 Twitter] Cleaning up browser instance (postReply)...');
        if (page && !page.isClosed()) await page.close().catch(e => logger.warn('[🐦 Twitter] Error closing page (postReply)', e));
        if (context) await context.close().catch(e => logger.warn('[🐦 Twitter] Error closing context (postReply)', e));
        if (browser) await browser.close().catch(e => logger.warn('[🐦 Twitter] Error closing browser (postReply)', e));
        logger.debug('[🐦 Twitter] Browser cleanup complete (postReply).');
    }
} 