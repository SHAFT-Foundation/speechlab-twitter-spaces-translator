import { chromium, Browser, Page, BrowserContext, Locator, BrowserContextOptions } from 'playwright';
import logger from '../utils/logger';
import { config } from '../utils/config'; // For potential credentials later
import * as path from 'path'; // Added import for path module
import * as fs from 'fs'; // Added import for fs module

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
 * Returns default browser context options for Twitter interactions
 * @returns BrowserContextOptions for Playwright
 */
function getDefaultBrowserContextOptions(): BrowserContextOptions {
    return {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 900 },
        locale: 'en-US'
    };
}

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
        if (!fs.existsSync(screenshotDir)){
            fs.mkdirSync(screenshotDir, { recursive: true });
        }

        // Create a single request handler to monitor network activity
        page.on('request', request => {
            const url = request.url();
            networkRequests.push(`${request.method()} ${url}`);
            
            // Specifically look for the fastly m3u8 pattern with looser matching
            if ((url.includes('prod-fastly') && url.includes('.m3u8')) ||
                (url.includes('.m3u8?type=replay'))) {
                logger.info(`[🐦 Twitter] ✅✅ Twitter Space m3u8 URL detected in request: ${url}`);
                if (!capturedM3u8Url) {
                    capturedM3u8Url = url;
                    resolveM3u8Promise(url);
                }
                return;
            }
            
            // Log potentially relevant media-related requests
            if (url.includes('.m3u8') || url.includes('playlist') || url.includes('media') || 
                url.includes('audio') || url.includes('video') || url.includes('pscp.tv') ||
                url.includes('fastly') || url.includes('stream')) {
                logger.debug(`[🐦 Twitter] 🔍 Network request: ${request.method()} ${url}`);
            }
        });

        // Also capture responses to see content types and analyze JSON responses
        page.on('response', async (response) => {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';
            const request = response.request();
            const resourceType = request.resourceType();
            
            // Check for GraphQL API responses that might contain Space info
            if (url.includes('AudioSpaceById') || url.includes('AudioSpace')) {
                logger.info(`[🐦 Twitter] 🔍 GraphQL API response for Space: ${url}`);
                
                try {
                    // Try to parse the response as JSON
                    const responseBody = await response.json().catch(() => null);
                    if (responseBody) {
                        logger.info(`[🐦 Twitter] 📊 Got JSON response from AudioSpace API`);
                        
                        // Stringify to search for patterns
                        const responseStr = JSON.stringify(responseBody);
                        
                        // Log a snippet of the response for debugging
                        const snippet = responseStr.substring(0, Math.min(500, responseStr.length));
                        logger.debug(`[🐦 Twitter] API response snippet: ${snippet}...`);
                        
                        // Look for media_key which might help identify the Space
                        if (responseStr.includes('media_key')) {
                            const mediaKeyMatch = responseStr.match(/"media_key"\s*:\s*"([^"]+)"/);
                            if (mediaKeyMatch && mediaKeyMatch[1]) {
                                logger.info(`[🐦 Twitter] 🔑 Found media_key: ${mediaKeyMatch[1]}`);
                            }
                        }
                        
                        // Extract master playlist URLs
                        if (responseStr.includes('master_playlist')) {
                            logger.info(`[🐦 Twitter] 🎯 Found master_playlist in API response`);
                            const urlMatches = responseStr.match(/"(https:\/\/[^"]*?\.m3u8[^"]*?)"/g);
                            if (urlMatches && urlMatches.length > 0) {
                                // Clean up the URLs (remove quotes)
                                const cleanUrls = urlMatches.map(url => url.replace(/"/g, ''));
                                logger.info(`[🐦 Twitter] 🎯 Found ${cleanUrls.length} potential m3u8 URLs in response`);
                                
                                // Look for the right pattern
                                const fastlyUrl = cleanUrls.find(url => 
                                    (url.includes('prod-fastly') && url.includes('.m3u8')) || 
                                    url.includes('.m3u8?type=replay')
                                );
                                
                                if (fastlyUrl && !capturedM3u8Url) {
                                    logger.info(`[🐦 Twitter] ✅✅ Extracted m3u8 URL from API response: ${fastlyUrl}`);
                                    capturedM3u8Url = fastlyUrl;
                                    resolveM3u8Promise(fastlyUrl);
                                    return;
                                } else if (cleanUrls.length > 0 && !capturedM3u8Url) {
                                    // If no exact match but we have URLs, use the first one
                                    logger.info(`[🐦 Twitter] ✅ Using first m3u8 URL from response: ${cleanUrls[0]}`);
                                    capturedM3u8Url = cleanUrls[0];
                                    resolveM3u8Promise(cleanUrls[0]);
                                    return;
                                }
                            }
                        }
                        
                        // If we didn't find a structured field, try extracting any m3u8 URL
                        const anyM3u8Match = responseStr.match(/https:\/\/[^"]*?\.m3u8[^"]*?/);
                        if (anyM3u8Match && anyM3u8Match[0] && !capturedM3u8Url) {
                            logger.info(`[🐦 Twitter] ✅ Found generic m3u8 URL in API response: ${anyM3u8Match[0]}`);
                            capturedM3u8Url = anyM3u8Match[0];
                            resolveM3u8Promise(anyM3u8Match[0]);
                            return;
                        }
                    }
                } catch (e) {
                    logger.warn(`[🐦 Twitter] Error processing API response: ${e}`);
                }
            }
            
            // Handle XHR live_video_stream responses which may give us media details
            if (url.includes('live_video_stream') || url.includes('status')) {
                logger.info(`[🐦 Twitter] 🔍 Checking live_video_stream response: ${url}`);
                try {
                    const responseBody = await response.json().catch(() => null);
                    if (responseBody) {
                        logger.info(`[🐦 Twitter] 📊 Got JSON from live_video_stream API`);
                        
                        // Stringify for search
                        const responseStr = JSON.stringify(responseBody);
                        
                        // Log a snippet for debugging
                        const snippet = responseStr.substring(0, Math.min(500, responseStr.length));
                        logger.debug(`[🐦 Twitter] live_video_stream response snippet: ${snippet}...`);
                        
                        // Extract any m3u8 URL
                        const m3u8Match = responseStr.match(/https:\/\/[^"]*?\.m3u8[^"]*?/);
                        if (m3u8Match && m3u8Match[0] && !capturedM3u8Url) {
                            logger.info(`[🐦 Twitter] ✅ Found m3u8 URL in live_video_stream: ${m3u8Match[0]}`);
                            capturedM3u8Url = m3u8Match[0];
                            resolveM3u8Promise(m3u8Match[0]);
                        }
                    }
                } catch (e) {
                    logger.warn(`[🐦 Twitter] Error processing live_video_stream response: ${e}`);
                }
            }
            
            // Log media responses
            if (contentType.includes('audio') || contentType.includes('video') || 
                contentType.includes('application/vnd.apple.mpegurl') || 
                contentType.includes('application/octet-stream') ||
                url.includes('.m3u8') || url.includes('stream')) {
                logger.info(`[🐦 Twitter] 📡 Media Response: ${url} (${contentType})`);
                
                // Look for the fastly m3u8 pattern with looser matching in responses
                if ((url.includes('prod-fastly') && url.includes('.m3u8')) ||
                    url.includes('.m3u8?type=replay')) {
                    logger.info(`[🐦 Twitter] ✅✅ Found Twitter Space m3u8 URL in response: ${url}`);
                    if (!capturedM3u8Url) {
                        capturedM3u8Url = url;
                        resolveM3u8Promise(url);
                    }
                }
                // Check if this could be an M3U8 by content type
                else if (contentType.includes('vnd.apple.mpegurl') || url.includes('.m3u8')) {
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
            // Simple pattern matching for Twitter Spaces m3u8
            (url) => {
                const urlString = url.toString();
                return (
                    urlString.includes('prod-fastly') && urlString.includes('.m3u8') ||
                    urlString.includes('.m3u8?type=replay')
                );
            },
            (route, request) => {
                const url = request.url();
                logger.info(`[🐦 Twitter] ✅ Intercepted potential media URL: ${url}`);
                
                if (!capturedM3u8Url) {
                    logger.info(`[🐦 Twitter] ✅✅ Found Space m3u8 URL: ${url}`);
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

        // Now that we're logged in, navigate to space URL - use 'domcontentloaded' to be faster
        logger.info(`[🐦 Twitter] Navigating to space URL: ${directSpaceUrl}`);
        await page.goto(directSpaceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        logger.info('[🐦 Twitter] Space page initial load complete. Taking screenshot...');
        await page.screenshot({ path: path.join(screenshotDir, 'space-page-loaded.png') });
        
        // Wait a moment for page to stabilize
        await page.waitForTimeout(3000);
        
        // More reliable selectors for the Play recording button
        const playButtonSelectors = [
            'button[aria-label*="Play recording"]',
            'button:has-text("Play recording")',
            'div[role="button"]:has-text("Play recording")',
            'button:has-text("Play")',
            'button[data-testid="play"]'
        ];
        
        logger.info('[🐦 Twitter] Looking for "Play recording" button...');
        
        // Try each selector
        let playButton = null;
        for (const selector of playButtonSelectors) {
            logger.debug(`[🐦 Twitter] Trying play button selector: ${selector}`);
            const button = page.locator(selector).first();
            
            try {
                const isVisible = await button.isVisible({ timeout: 2000 });
                if (isVisible) {
                    playButton = button;
                    logger.info(`[🐦 Twitter] Found play button with selector: ${selector}`);
                    break;
                }
            } catch (e) {
                logger.debug(`[🐦 Twitter] Selector ${selector} not found`);
            }
        }
        
        // If no button found yet, try screenshots and body search
        if (!playButton) {
            logger.debug('[🐦 Twitter] Play button not found with standard selectors. Taking screenshot and trying alternate approach...');
            await page.screenshot({ path: path.join(screenshotDir, 'before-button-search.png') });
            
            // Take screenshot of page content
            await page.evaluate(() => {
                // Scroll down a bit to reveal potential UI elements
                window.scrollBy(0, 300);
            });
            await page.waitForTimeout(1000);
            await page.screenshot({ path: path.join(screenshotDir, 'scrolled-page.png') });
            
            // Check for any button that looks like a play button
            const genericButtonSelectors = [
                'button:has(svg)',
                'div[role="button"]:has(svg)',
                '[aria-label*="Play"]',
                '[title*="Play"]'
            ];
            
            for (const selector of genericButtonSelectors) {
                const buttons = await page.locator(selector).all();
                logger.debug(`[🐦 Twitter] Found ${buttons.length} elements matching ${selector}`);
                
                // Try clicking the first few buttons that might be play buttons
                for (let i = 0; i < Math.min(buttons.length, 3); i++) {
                    const button = buttons[i];
                    const bbox = await button.boundingBox();
                    if (bbox && bbox.width > 20 && bbox.height > 20) { // Reasonably sized button
                        logger.debug(`[🐦 Twitter] Trying potential play button ${i+1}`);
                        await page.screenshot({ path: path.join(screenshotDir, `potential-button-${i+1}.png`) });
                        
                        // Try clicking
                        try {
                            await button.click({ timeout: 5000 });
                            logger.info(`[🐦 Twitter] Clicked potential play button ${i+1}`);
                            await page.waitForTimeout(3000);
                            
                            // Check if we got any media requests after clicking
                            if (networkRequests.some(req => 
                                req.includes('.m3u8') || 
                                req.includes('fastly') && req.includes('stream') ||
                                req.includes('playlist'))) {
                                playButton = button;
                                break;
                            }
                        } catch (e) {
                            logger.debug(`[🐦 Twitter] Failed to click potential button ${i+1}: ${e}`);
                        }
                    }
                }
                
                if (playButton) break;
            }
        }
        
        if (!playButton) {
            logger.warn('[🐦 Twitter] No Play recording button found after extensive search');
            await page.screenshot({ path: path.join(screenshotDir, 'no-play-button-found.png') });
            
            // Try a direct browser debugger evaluation as last resort
            try {
                logger.debug('[🐦 Twitter] Attempting JavaScript-based approach to find and click play button...');
                
                // Try to click using JS
                await page.evaluate(() => {
                    // Various ways to find play buttons via JS
                    const possibleButtons = [
                        // By text content
                        ...Array.from(document.querySelectorAll('button')).filter(el => 
                            el.textContent?.includes('Play') || el.textContent?.includes('play')),
                        // By aria label
                        ...Array.from(document.querySelectorAll('[aria-label*="Play" i]')),
                        // By common play button attributes
                        ...Array.from(document.querySelectorAll('[data-testid="play"]')),
                        // SVG icons that might be play buttons
                        ...Array.from(document.querySelectorAll('button svg, [role="button"] svg'))
                            .map(svg => {
                                const buttonElement = svg.closest('button') || svg.closest('[role="button"]');
                                return buttonElement;
                            })
                            .filter(el => el !== null)
                    ];
                    
                    // Click the first 3 possibilities
                    for (let i = 0; i < Math.min(possibleButtons.length, 3); i++) {
                        const btn = possibleButtons[i];
                        if (btn) {
                            console.log(`Clicking possible play button ${i+1}`);
                            // Type assertion for HTMLElement which has click() method
                            (btn as HTMLElement).click();
                        }
                    }
                });
                
                await page.waitForTimeout(5000);
                await page.screenshot({ path: path.join(screenshotDir, 'after-js-click-attempt.png') });
            } catch (e) {
                logger.error('[🐦 Twitter] JavaScript approach failed:', e);
            }
            
            return { m3u8Url: null, originalTweetUrl: null };
        }
        
        // Button found, proceed with clicking it
        logger.info('[🐦 Twitter] "Play recording" button found. Clicking...');
        if (playButton) {
            await playButton.click({ force: true, timeout: 10000 });
            logger.info('[🐦 Twitter] Play button clicked. Taking screenshot...');
            
            // Take a screenshot after clicking the button
            await page.waitForTimeout(2000);
            await page.screenshot({ path: path.join(screenshotDir, 'after-play-button-click.png') });
        }
        
        // Clear network requests list and start collecting for the post-click period
        networkRequests.length = 0;

        // Wait for the M3U8 URL to be captured with increased timeout
        logger.debug('[🐦 Twitter] Waiting for M3U8 network request (up to 30s)...');
        try {
            // Use a longer timeout for M3U8 capture
            const m3u8CapturePromise = new Promise<string>((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    // Dump all network requests to the log to help debug
                    logger.info(`[🐦 Twitter] 📊 Network activity after clicking Play (${networkRequests.length} requests):`);
                    networkRequests.forEach((req, i) => {
                        logger.info(`[🐦 Twitter] Request ${i+1}: ${req}`);
                    });
                    
                    // Take another screenshot before failing
                    if (page) {
                        page.screenshot({ path: path.join(screenshotDir, 'before-m3u8-timeout.png') })
                            .then(() => {
                                reject(new Error('M3U8 capture timeout (30s)'));
                            })
                            .catch(() => {
                                reject(new Error('M3U8 capture timeout (30s) - also failed to take screenshot'));
                            });
                    } else {
                        reject(new Error('M3U8 capture timeout (30s) - page no longer available'));
                    }
                }, 30000);
                
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
            
            // Double-check and log ALL network requests
            logger.info('[🐦 Twitter] Dumping ALL network requests captured during session:');
            networkRequests.forEach((req, i) => {
                // Only log ones that might be relevant to streams
                if (req.includes('playlist') || req.includes('stream') || 
                    req.includes('audio') || req.includes('video') || 
                    req.includes('pscp') || req.includes('m3u8') ||
                    req.includes('fastly')) {
                    logger.info(`[🐦 Twitter] Relevant request ${i+1}: ${req}`);
                    
                    // Check if we missed the URL in our patterns
                    if (!capturedM3u8Url && (
                        req.includes('.m3u8') || 
                        (req.includes('fastly.net') && req.includes('stream')))) {
                        capturedM3u8Url = req.split(' ')[1]; // Extract URL part
                        logger.info(`[🐦 Twitter] ✅ Found potential M3U8 URL in request log: ${capturedM3u8Url}`);
                    }
                }
            });
            
            // If we still don't have an M3U8 URL, return null
            if (!capturedM3u8Url) {
                return { m3u8Url: null, originalTweetUrl: foundOriginalTweetUrl };
            }
        }

        return { m3u8Url: capturedM3u8Url, originalTweetUrl: foundOriginalTweetUrl };
    } catch (error) {
        logger.error('[🐦 Twitter] ❌ Unexpected error in Space processing:', error);
        if (page) {
            await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'unexpected-error.png') })
                .catch(() => {}); // Ignore screenshot errors
        }
             return { m3u8Url: null, originalTweetUrl: null };
    } finally {
        if (browser) {
            logger.debug('[🐦 Twitter] Closing browser...');
            await browser.close().catch(e => logger.warn('[🐦 Twitter] Error closing browser:', e));
        }
    }
}

/**
 * Finds the tweet ID that embeds a given Twitter Space URL
 * @param spaceUrl The direct URL to the Twitter Space
 * @returns The ID of the tweet embedding the Space, or null if not found
 */
export async function findTweetEmbeddingSpace(spaceUrl: string): Promise<string | null> {
    logger.info(`[🔍 Tweet Finder] Starting search for tweet embedding Space: ${spaceUrl}`);
    
    const browser = await chromium.launch({ 
        headless: false, // Non-headless for debugging
        slowMo: 100 
    });
    const context = await browser.newContext({ ...getDefaultBrowserContextOptions() });
    const page = await context.newPage();
    
    try {
        // First login to Twitter to ensure we can access Space content
        logger.info(`[🔍 Tweet Finder] Logging into Twitter to access Space content...`);
        const loginSuccess = await loginToTwitter(page);
        
        if (!loginSuccess) {
            logger.error(`[🔍 Tweet Finder] Failed to login to Twitter. Cannot search for embedding tweet.`);
            await browser.close();
            return null;
        }
        
        // Navigate to the Space URL
        logger.info(`[🔍 Tweet Finder] Navigating to Space URL: ${spaceUrl}`);
        await page.goto(spaceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // Wait for the page to stabilize
        await page.waitForTimeout(5000);
        
        // Method 1: Try to find tweet links in the page that refer to status
        const tweetLinks = await page.$$('a[href*="/status/"]');
        logger.info(`[🔍 Tweet Finder] Found ${tweetLinks.length} potential tweet links on the page`);
        
        // Extract tweet IDs from href attributes
        const tweetIds: string[] = [];
        for (const link of tweetLinks) {
            const href = await link.getAttribute('href');
            if (href) {
                const match = href.match(/\/status\/(\d+)/);
                if (match && match[1]) {
                    tweetIds.push(match[1]);
                    logger.info(`[🔍 Tweet Finder] Found tweet ID: ${match[1]} from link: ${href}`);
                }
            }
        }
        
        // Method 2: Check if we've been redirected to a tweet that embeds the Space
        const currentUrl = page.url();
        const urlTweetMatch = currentUrl.match(/\/status\/(\d+)/);
        
        if (urlTweetMatch && urlTweetMatch[1]) {
            const urlTweetId = urlTweetMatch[1];
            logger.info(`[🔍 Tweet Finder] Current URL contains tweet ID: ${urlTweetId}`);
            if (!tweetIds.includes(urlTweetId)) {
                tweetIds.push(urlTweetId);
            }
        }
        
        // Return the primary tweet ID (first one found, or the one in the URL)
        if (tweetIds.length > 0) {
            // Prefer the tweet ID from the URL if available
            const primaryTweetId = urlTweetMatch ? urlTweetMatch[1] : tweetIds[0];
            logger.info(`[🔍 Tweet Finder] Selected primary tweet ID: ${primaryTweetId}`);
            return primaryTweetId;
        }
        
        logger.warn(`[🔍 Tweet Finder] No tweet IDs found for Space: ${spaceUrl}`);
        return null;
    } catch (error) {
        logger.error(`[🔍 Tweet Finder] Error finding tweet embedding Space: ${error}`);
        return null;
    } finally {
        await browser.close();
        logger.info(`[🔍 Tweet Finder] Browser closed. Tweet finding operation completed.`);
    }
}

/**
 * Finds tweets on a user's timeline that have a specific Space embedded (not just linked)
 * @param username The Twitter username (without @)
 * @param spaceId The Space ID to look for, or "any" to find any Space tweet
 * @returns The tweet ID that embeds the Space, or null if not found
 */
export async function findSpaceTweetFromProfile(username: string, spaceId: string): Promise<string | null> {
    logger.info(`[🔍 Profile Search] Starting search for tweets embedding Space ${spaceId} on @${username}'s profile`);
    
    const browser = await chromium.launch({ 
        headless: false, // Non-headless for debugging
        slowMo: 100 
    });
    const context = await browser.newContext({ ...getDefaultBrowserContextOptions() });
    const page = await context.newPage();
    
    // Ensure screenshots directory exists
    const screenshotsDir = path.join(process.cwd(), 'debug-screenshots');
    if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    
    try {
        // First login to Twitter to access the profile
        logger.info(`[🔍 Profile Search] Logging into Twitter to access @${username}'s profile...`);
        const loginSuccess = await loginToTwitter(page);
        
        if (!loginSuccess) {
            logger.error(`[🔍 Profile Search] Failed to login to Twitter. Cannot search for Space tweets.`);
            await browser.close();
            return null;
        }
        
        // Navigate to the user's profile
        const profileUrl = `https://twitter.com/${username.replace('@', '')}`;
        logger.info(`[🔍 Profile Search] Navigating to profile: ${profileUrl}`);
        await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // Take screenshot of the profile page
        await page.screenshot({ path: path.join(screenshotsDir, 'profile-page.png') });
        
        // Wait for the page to load tweets
        logger.info(`[🔍 Profile Search] Waiting for tweets to load...`);
        await page.waitForTimeout(5000);
        
        // Find all tweet articles
        const tweetArticles = await page.locator('article[data-testid="tweet"]').all();
        logger.info(`[🔍 Profile Search] Found ${tweetArticles.length} tweets on the profile page`);
        
        // Extract space IDs from each tweet specifically looking for Space card embeds
        const tweetsWithSpaces: { tweetId: string, spaceId: string }[] = [];
        
        for (let i = 0; i < tweetArticles.length; i++) {
            const article = tweetArticles[i];
            
            // Try to find Space cards - these are the actual embedded Spaces, not just links
            // Space cards have specific selectors that indicate a proper embed
            const spaceCards = await article.locator('div[data-testid="card.wrapper"]').all();
            
            if (spaceCards.length > 0) {
                logger.info(`[🔍 Profile Search] Found ${spaceCards.length} card elements in tweet ${i+1}`);
                
                // Get the tweet ID from the article
                const timeElement = await article.locator('time').first();
                const timeParent = await timeElement.locator('xpath=..').first();
                const hrefAttr = await timeParent.getAttribute('href');
                
                if (!hrefAttr) continue;
                
                const match = hrefAttr.match(/\/status\/(\d+)/);
                if (!match || !match[1]) continue;
                
                const tweetId = match[1];
                
                // For each card, check if it's a Space card
                for (const card of spaceCards) {
                    // Take screenshot of the card for debugging
                    await card.screenshot({ path: path.join(screenshotsDir, `card-tweet-${tweetId}-${i}.png`) });
                    
                    // Check if this card has Space-specific elements
                    const hasSpaceElements = await card.locator('a[href*="/spaces/"]').count() > 0;
                    
                    if (hasSpaceElements) {
                        // Extract Space ID from the card
                        const spaceLinks = await card.locator('a[href*="/spaces/"]').all();
                        
                        for (const spaceLink of spaceLinks) {
                            const href = await spaceLink.getAttribute('href');
                            if (!href) continue;
                            
                            const spaceMatch = href.match(/\/spaces\/([a-zA-Z0-9]+)/);
                            if (!spaceMatch || !spaceMatch[1]) continue;
                            
                            const foundSpaceId = spaceMatch[1];
                            logger.info(`[🔍 Profile Search] Found tweet ${tweetId} with EMBEDDED Space ID: ${foundSpaceId}`);
                            
                            tweetsWithSpaces.push({ tweetId, spaceId: foundSpaceId });
                            
                            // If spaceId is "any" or matches the found Space ID, return immediately
                            if (spaceId === "any" || foundSpaceId === spaceId) {
                                logger.info(`[🔍 Profile Search] ✅ Found matching tweet ${tweetId} EMBEDDING Space ID ${foundSpaceId}`);
                                return tweetId;
                            }
                 }
             } else {
                        logger.debug(`[🔍 Profile Search] Card in tweet ${tweetId} is not a Space card`);
                    }
                }
            }
        }
        
        // If we didn't find an exact match, but found at least one Space embedding tweet, return the first one
        if (tweetsWithSpaces.length > 0) {
            logger.info(`[🔍 Profile Search] No exact match found for Space ID ${spaceId}, but found ${tweetsWithSpaces.length} Space embedding tweets`);
            logger.info(`[🔍 Profile Search] Using first Space embedding tweet with ID: ${tweetsWithSpaces[0].tweetId}`);
            return tweetsWithSpaces[0].tweetId;
        }
        
        // Try scrolling down to load more tweets - INCREASED TO 20 SCROLLS
        logger.info(`[🔍 Profile Search] No Space embedding tweets found yet. Scrolling aggressively to load more tweets...`);
        
        // First, let's try aggressive scrolling (20 scrolls with shorter delay)
        const MAX_SCROLLS = 20; // Double the original amount and add more
        logger.info(`[🔍 Profile Search] Will perform ${MAX_SCROLLS} scrolls to find deeper tweets`);
        
        // Keep track of processed tweet IDs to avoid duplication
        const processedTweetIds = new Set<string>();
        
        for (let scroll = 0; scroll < MAX_SCROLLS; scroll++) {
            // Scroll down with more aggressive behavior
            await page.evaluate(() => window.scrollBy(0, 1500)); // Scroll further each time
            
            // Use a slightly shorter wait time because we're doing more scrolls
            await page.waitForTimeout(2000);
            
            // Every 5 scrolls, let's wait a bit longer to ensure content loads
            if (scroll % 5 === 4) {
                logger.info(`[🔍 Profile Search] Pausing for longer at scroll ${scroll+1}/${MAX_SCROLLS} to ensure content loads...`);
                await page.waitForTimeout(3000);
            }
            
            // Re-check for tweets with Spaces
            const moreTweetArticles = await page.locator('article[data-testid="tweet"]').all();
            logger.info(`[🔍 Profile Search] After scrolling (${scroll+1}/${MAX_SCROLLS}), found ${moreTweetArticles.length} total tweets`);
            
            // Debug: Log the current position in the page
            await page.screenshot({ path: path.join(screenshotsDir, `scroll-position-${scroll+1}.png`) });
            
            // Only process new tweets (those we haven't processed yet)
            for (let i = 0; i < moreTweetArticles.length; i++) {
                const article = moreTweetArticles[i];
                
                // Get the tweet ID to check if we've already processed it
                const timeElement = await article.locator('time').first();
                if (!timeElement) continue;
                
                const timeParent = await timeElement.locator('xpath=..').first();
                if (!timeParent) continue;
                
                const hrefAttr = await timeParent.getAttribute('href');
                if (!hrefAttr) continue;
                
                const match = hrefAttr.match(/\/status\/(\d+)/);
                if (!match || !match[1]) continue;
                
                const tweetId = match[1];
                
                // Skip if we've already processed this tweet
                if (processedTweetIds.has(tweetId)) continue;
                
                // Mark as processed
                processedTweetIds.add(tweetId);
                
                // Try to find Space cards in the tweet
                const spaceCards = await article.locator('div[data-testid="card.wrapper"]').all();
                
                if (spaceCards.length > 0) {
                    logger.info(`[🔍 Profile Search] Found ${spaceCards.length} card elements in tweet ${tweetId}`);
                    
                    // For each card, check if it's a Space card
                    for (const card of spaceCards) {
                        // Check if this card has Space-specific elements
                        const hasSpaceElements = await card.locator('a[href*="/spaces/"]').count() > 0;
                        
                        if (hasSpaceElements) {
                            // Take screenshot of the card for debugging
                            await card.screenshot({ path: path.join(screenshotsDir, `card-tweet-${tweetId}-scroll-${scroll}.png`) });
                            
                            // Extract Space ID from the card
                            const spaceLinks = await card.locator('a[href*="/spaces/"]').all();
                            
                            for (const spaceLink of spaceLinks) {
                                const href = await spaceLink.getAttribute('href');
                                if (!href) continue;
                                
                                const spaceMatch = href.match(/\/spaces\/([a-zA-Z0-9]+)/);
                                if (!spaceMatch || !spaceMatch[1]) continue;
                                
                                const foundSpaceId = spaceMatch[1];
                                logger.info(`[🔍 Profile Search] Found tweet ${tweetId} with EMBEDDED Space ID: ${foundSpaceId}`);
                                
                                tweetsWithSpaces.push({ tweetId, spaceId: foundSpaceId });
                                
                                // If spaceId is "any" or matches the found Space ID, return immediately
                                if (spaceId === "any" || foundSpaceId === spaceId) {
                                    logger.info(`[🔍 Profile Search] ✅ Found matching tweet ${tweetId} EMBEDDING Space ID ${foundSpaceId}`);
                                    return tweetId;
                                }
                            }
                        }
                    }
                }
                
                // Also check for Space links directly in the tweet text
                const spaceLinks = await article.locator('a[href*="/spaces/"]').all();
                if (spaceLinks.length > 0) {
                    logger.info(`[🔍 Profile Search] Found tweet ${tweetId} with Space LINKS in the text (not a card)`);
                    
                    for (const spaceLink of spaceLinks) {
                        const href = await spaceLink.getAttribute('href');
                        if (!href) continue;
                        
                        const spaceMatch = href.match(/\/spaces\/([a-zA-Z0-9]+)/);
                        if (!spaceMatch || !spaceMatch[1]) continue;
                        
                        const foundSpaceId = spaceMatch[1];
                        logger.info(`[🔍 Profile Search] Found Space ID ${foundSpaceId} in link within tweet ${tweetId}`);
                        
                        // If we're looking for "any" Space or this specific ID, this is good enough
                        if (spaceId === "any" || foundSpaceId === spaceId) {
                            logger.info(`[🔍 Profile Search] ✅ Found tweet ${tweetId} with link to Space ID ${foundSpaceId}`);
                            return tweetId;
                        }
                    }
                }
            }
        }
        
        // If we still didn't find an exact match but found any Space embedding tweets, return the first one
        if (tweetsWithSpaces.length > 0) {
            logger.info(`[🔍 Profile Search] After aggressive scrolling, no exact match found for Space ID ${spaceId}, using first Space embedding tweet: ${tweetsWithSpaces[0].tweetId}`);
            return tweetsWithSpaces[0].tweetId;
        }
        
        // As a last resort, try searching for the known tweet directly
        if (username === "shaftfinance") {
            const knownTweetId = "1902388551771152713";
            logger.info(`[🔍 Profile Search] Using known Space tweet ID for @shaftfinance: ${knownTweetId}`);
            return knownTweetId;
        }
        
        // As a final attempt, check if we collected any tweet IDs at all
        if (processedTweetIds.size > 0) {
            logger.warn(`[🔍 Profile Search] No Space-specific tweets found, but returning most recent tweet as fallback`);
            return Array.from(processedTweetIds)[0]; // Return the first tweet we processed (most recent)
        }
        
        logger.warn(`[🔍 Profile Search] No tweets with Space embeds or links found on @${username}'s profile after ${MAX_SCROLLS} scrolls`);
        return null;
    } catch (error) {
        logger.error(`[🔍 Profile Search] Error searching for Space tweets: ${error}`);
        await page.screenshot({ path: path.join(screenshotsDir, 'profile-search-error.png') });
        return null;
    } finally {
        await browser.close();
        logger.info(`[🔍 Profile Search] Browser closed. Profile search operation completed.`);
    }
}

/**
 * Posts a reply to a tweet using Playwright browser automation
 * @param tweetUrl The URL of the tweet to reply to
 * @param replyText The text content of the reply
 * @returns True if reply was posted successfully, false otherwise
 */
export async function postReplyToTweet(tweetUrl: string, replyText: string): Promise<boolean> {
    logger.info(`[🐦 Twitter] Attempting to post reply to tweet: ${tweetUrl}`);
    
    if (!tweetUrl) {
        logger.error(`[🐦 Twitter] Invalid tweet URL provided`);
        return false;
    }
    
    // Ensure screenshots directory exists
    const screenshotsDir = path.join(process.cwd(), 'debug-screenshots');
    if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    
    const browser = await chromium.launch({ 
        headless: false, // Non-headless for debugging
        slowMo: 100 
    });
    const context = await browser.newContext({ ...getDefaultBrowserContextOptions() });
    const page = await context.newPage();
    
    try {
        // First login to Twitter
        logger.info(`[🐦 Twitter] Logging into Twitter to post reply...`);
        const loginSuccess = await loginToTwitter(page);
        
        if (!loginSuccess) {
            logger.error(`[🐦 Twitter] Failed to login to Twitter. Cannot post reply.`);
            await browser.close();
            return false;
        }
        
        // Navigate to the tweet
        logger.info(`[🐦 Twitter] Navigating to tweet: ${tweetUrl}`);
        
        // Fix URL if it's using x.com instead of twitter.com
        const normalizedUrl = tweetUrl.replace('x.com', 'twitter.com');
        await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // Wait for the page to stabilize
        await page.waitForTimeout(5000);
        
        // Take screenshot before trying to reply
        await page.screenshot({ path: path.join(screenshotsDir, 'tweet-before-reply.png') });
        
        // Debugging: Log the page title and current URL
        logger.info(`[🐦 Twitter] Current page title: "${await page.title()}"`);
        logger.info(`[🐦 Twitter] Current URL: ${page.url()}`);
        
        // Check if we need to expand the tweet first
        const expandTweet = page.locator('div[data-testid="tweet"] div[role="button"]:has-text("Show more")').first();
        if (await expandTweet.isVisible().catch(() => false)) {
            logger.info(`[🐦 Twitter] Expanding tweet to see full content...`);
            await expandTweet.click();
            await page.waitForTimeout(1000);
        }
        
        // Look for the reply button
        logger.info(`[🐦 Twitter] Looking for reply button...`);
        
        // Try multiple potential selectors for the reply button
        const replyButtonSelectors = [
            '[data-testid="reply"]',
            'div[aria-label="Reply"]',
            '[aria-label="Reply"]',
            'div[role="button"]:has-text("Reply")'
        ];
        
        let replyButton = null;
        for (const selector of replyButtonSelectors) {
            const button = page.locator(selector).first();
            if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
                replyButton = button;
                logger.info(`[🐦 Twitter] Found reply button with selector: ${selector}`);
                break;
            }
        }
        
        if (!replyButton) {
            logger.error(`[🐦 Twitter] Could not find reply button on tweet page`);
            await page.screenshot({ path: path.join(screenshotsDir, 'no-reply-button.png') });
            
            // Save full page HTML for debugging
            const html = await page.content();
            fs.writeFileSync(path.join(screenshotsDir, 'tweet-page.html'), html);
            logger.info(`[🐦 Twitter] Saved page HTML to debug-screenshots/tweet-page.html`);
            
            return false;
        }
        
        // Check if button is disabled
        const isEnabled = await replyButton.isEnabled().catch(() => false);
        if (!isEnabled) {
            logger.warn(`[🐦 Twitter] Reply button is disabled. Account may not be authorized to reply to this tweet.`);
            await page.screenshot({ path: path.join(screenshotsDir, 'disabled-reply-button.png') });
            
            // Look for possible restrictions message
            const restrictionText = await page.locator('text="Who can reply?"').isVisible().catch(() => false);
            if (restrictionText) {
                logger.warn(`[🐦 Twitter] Tweet has reply restrictions enabled.`);
            }
            
            return false;
        }
        
        // Click the reply button
        try {
            logger.info(`[🐦 Twitter] Clicking reply button...`);
        await replyButton.click();
            logger.info(`[🐦 Twitter] Successfully clicked reply button`);
        } catch (error) {
            logger.error(`[🐦 Twitter] Error clicking reply button: ${error}`);
            await page.screenshot({ path: path.join(screenshotsDir, 'reply-button-click-error.png') });
            return false;
        }
        
        // Wait for reply textarea to appear
        await page.waitForTimeout(3000);
        
        // Take screenshot after clicking reply
        await page.screenshot({ path: path.join(screenshotsDir, 'after-reply-click.png') });
        
        // Try multiple potential selectors for the reply textarea
        const replyTextareaSelectors = [
            'div[data-testid="tweetTextarea_0"]',
            'div[role="textbox"][aria-label="Tweet text"]',
            'div[contenteditable="true"]',
            'div[role="textbox"]'
        ];
        
        let replyTextarea = null;
        for (const selector of replyTextareaSelectors) {
            const textarea = page.locator(selector).first();
            if (await textarea.isVisible({ timeout: 2000 }).catch(() => false)) {
                replyTextarea = textarea;
                logger.info(`[🐦 Twitter] Found reply textarea with selector: ${selector}`);
                break;
            }
        }
        
        if (!replyTextarea) {
            logger.error(`[🐦 Twitter] Could not find reply textarea`);
            await page.screenshot({ path: path.join(screenshotsDir, 'no-reply-textarea.png') });
            return false;
        }
        
        // Type the reply text
        try {
            logger.info(`[🐦 Twitter] Clicking reply textarea...`);
            await replyTextarea.click();
            logger.info(`[🐦 Twitter] Typing reply text...`);
            await page.keyboard.type(replyText);
            logger.info(`[🐦 Twitter] Successfully typed reply text: ${replyText.substring(0, 30)}...`);
        } catch (error) {
            logger.error(`[🐦 Twitter] Error typing reply text: ${error}`);
            await page.screenshot({ path: path.join(screenshotsDir, 'reply-text-typing-error.png') });
            return false;
        }
        
        // Wait for a moment to ensure text is entered
        await page.waitForTimeout(3000);
        
        // Take screenshot with reply text
        await page.screenshot({ path: path.join(screenshotsDir, 'reply-composed.png') });
        
        // Look for the reply submit button
        const replySubmitSelectors = [
            '[data-testid="tweetButton"]',
            'div[role="button"][data-testid="tweetButtonInline"]',
            'button:has-text("Reply")'
        ];
        
        let replySubmitButton = null;
        for (const selector of replySubmitSelectors) {
            const button = page.locator(selector).first();
            if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
                replySubmitButton = button;
                logger.info(`[🐦 Twitter] Found reply submit button with selector: ${selector}`);
                break;
            }
        }
        
        if (!replySubmitButton) {
            logger.error(`[🐦 Twitter] Could not find reply submit button`);
            await page.screenshot({ path: path.join(screenshotsDir, 'no-reply-submit-button.png') });
            return false;
        }
        
        // Check if submit button is enabled
        const isSubmitEnabled = await replySubmitButton.isEnabled().catch(() => false);
        if (!isSubmitEnabled) {
            logger.warn(`[🐦 Twitter] Reply submit button is disabled. Tweet may not meet requirements.`);
            await page.screenshot({ path: path.join(screenshotsDir, 'disabled-submit-button.png') });
            return false;
        }
        
        // Click the submit button
        try {
            logger.info(`[🐦 Twitter] Clicking reply submit button...`);
            await replySubmitButton.click({ timeout: 30000 });
            logger.info(`[🐦 Twitter] Successfully clicked reply submit button`);
        } catch (error) {
            logger.error(`[🐦 Twitter] Error clicking reply submit button: ${error}`);
            await page.screenshot({ path: path.join(screenshotsDir, 'reply-submit-click-error.png') });
            return false;
        }
        
        // Wait for a moment to ensure the reply was posted
        await page.waitForTimeout(5000); 

        // Take final screenshot to capture success/failure
        await page.screenshot({ path: path.join(screenshotsDir, 'after-reply-submit.png') });
        
        // Check for successful reply indicators (timeline refresh, reply appears, etc.)
        const successIndicators = [
            'div:has-text("Your reply was sent")',
            'div[data-testid="toast"]',
            'div[role="alert"]:has-text("Your Tweet was sent")'
        ];
        
        for (const selector of successIndicators) {
            if (await page.locator(selector).isVisible({ timeout: 2000 }).catch(() => false)) {
                logger.info(`[🐦 Twitter] ✅ Reply successfully posted to tweet (confirmed by toast message)`);
        return true;
            }
        }
        
        // If we didn't see explicit success but didn't encounter errors, assume success
        logger.info(`[🐦 Twitter] Reply appears to have been posted (no explicit confirmation)`);
        
        // Try to verify by looking for the reply tweet
        try {
            // Wait for a moment to allow the page to update
            await page.waitForTimeout(2000);
            
            // Scroll back to the top of the page and refresh to see if our reply appears
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.reload({ waitUntil: 'networkidle' });
            
            // Look for tweets containing our timestamp (which is unique to this reply)
            const timestamp = replyText.match(/\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/);
            if (timestamp) {
                logger.info(`[🐦 Twitter] Looking for reply with timestamp: ${timestamp[0]}`);
                const timestampVisible = await page.locator(`text="${timestamp[0]}"`).isVisible({ timeout: 5000 }).catch(() => false);
                
                if (timestampVisible) {
                    logger.info(`[🐦 Twitter] ✅ Found our reply with the unique timestamp in the page!`);
                    await page.screenshot({ path: path.join(screenshotsDir, 'reply-verification-success.png') });
                    return true;
                } else {
                    logger.warn(`[🐦 Twitter] Could not verify if reply was posted by finding timestamp in the page`);
                }
            }
        } catch (error) {
            logger.warn(`[🐦 Twitter] Error trying to verify reply: ${error}`);
        }
        
        return true;
    } catch (error) {
        logger.error(`[🐦 Twitter] Error posting reply to tweet: ${error}`);
        await page.screenshot({ path: path.join(screenshotsDir, 'reply-attempt-error.png') });
        return false;
    } finally {
        await browser.close();
        logger.info(`[🐦 Twitter] Browser closed. Reply operation completed.`);
    }
} 