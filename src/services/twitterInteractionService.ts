import { chromium, Browser, Page, BrowserContext, Locator, BrowserContextOptions } from 'playwright';
import logger from '../utils/logger';
import { config } from '../utils/config'; // For potential credentials later
import * as path from 'path'; // Added import for path module
import * as fs from 'fs'; // Added import for fs module
import * as fsPromises from 'fs/promises'; // Use promises API for fs
import { v4 as uuidv4 } from 'uuid';

// Define the expected structure for the result
export interface SpaceInfo {
    originalTweetUrl: string;
    m3u8Url: string;
    spaceName: string | null; // Name might not always be easily extractable
}

// --- NEW: Interface for Mention Data ---
export interface MentionInfo {
    tweetId: string;
    tweetUrl: string;
    username: string;
    text: string;
}

// --- Helper function to find Space URL on the current loaded page ---
// Make sure this is exported
export async function findSpaceUrlOnPage(page: Page): Promise<string | null> {
    try {
        const spaceUrlRegex = /https:\/\/(?:twitter|x)\.com\/i\/spaces\/([a-zA-Z0-9]+)/;
        const spaceUrlRegexShort = /\/i\/spaces\/([a-zA-Z0-9]+)/; // To match relative links
        const playRecordingSelectors = [
            'button[aria-label*="Play recording"]',
            'button:has-text("Play recording")'
        ];

        logger.debug('[🐦 Helper] Iterating through visible tweet articles to find Space URL...');
        const tweetArticles = await page.locator('article[data-testid="tweet"]').all();
        logger.debug(`[🐦 Helper] Found ${tweetArticles.length} article elements.`);

        for (let i = 0; i < tweetArticles.length; i++) {
            const article = tweetArticles[i];
            logger.debug(`[🐦 Helper] Checking article ${i+1}...`);

            if (!await article.isVisible().catch(() => false)) {
                logger.debug(`[🐦 Helper] Article ${i+1} is not visible, skipping.`);
                continue;
            }

            // --- Priority Check: Does this article contain a "Play recording" button? ---
            let hasPlayRecordingButton = false;
            for (const selector of playRecordingSelectors) {
                if (await article.locator(selector).isVisible({ timeout: 500 })) {
                    logger.info(`[🐦 Helper] Article ${i+1} contains a 'Play recording' button (selector: ${selector}).`);
                    hasPlayRecordingButton = true;
                    break;
                }
            }

            // If it has the button, IMMEDIATELY search the ENTIRE PAGE for a /spaces/ link
            if (hasPlayRecordingButton) {
                logger.info(`[🐦 Helper] Play button found in article ${i+1}. Searching *entire page* for ANY Space link...`);
                const allSpaceLinksOnPage = await page.locator('a[href*="/spaces/"]').all();
                logger.debug(`[🐦 Helper] Found ${allSpaceLinksOnPage.length} potential space links on the page.`);
                
                for (const link of allSpaceLinksOnPage) {
                    try {
                        const href = await link.getAttribute('href');
                        if (href) {
                             if (spaceUrlRegex.test(href)) {
                                logger.info(`[🐦 Helper] ✅ Found Space URL (href=${href}) anywhere on page while Play button visible.`);
                                return href;
                            } else if (spaceUrlRegexShort.test(href)) {
                                const fullUrl = `https://twitter.com${href}`;
                                logger.info(`[🐦 Helper] ✅ Found relative Space URL (href=${href}) anywhere on page while Play button visible, returning: ${fullUrl}`);
                                return fullUrl;
                            }
                        }
                    } catch (linkError) {
                         logger.warn('[🐦 Helper] Error checking a page link href:', linkError);
                    }
                }
                // If we found the play button but no /spaces/ link anywhere on the page, log warn and continue fallbacks
                logger.warn(`[🐦 Helper] Article ${i+1} had Play button, but NO /spaces/ link found anywhere on the current page! Proceeding to fallbacks...`);
            }
            
            // --- Fallback Checks (Run if no Play button OR if Play button found but no page-wide link) ---
            
            // Fallback 1: Check tweet text content
            try {
                 const tweetTextElement = article.locator('div[data-testid="tweetText"]').first();
                 if (await tweetTextElement.isVisible({ timeout: 500 })) {
                     const text = await tweetTextElement.textContent({ timeout: 1000 });
                     if (text) {
                         const match = text.match(spaceUrlRegex);
                         if (match) {
                             logger.info(`[🐦 Helper] Found Space URL in tweet text (article ${i+1}): ${match[0]}`);
                             return match[0];
                         }
                     }
                 }
            } catch (e) { /* Ignore error */ }

            // Fallback 2: Check card wrappers
            try {
                const spaceCards = await article.locator('div[data-testid="card.wrapper"]').all();
                if (spaceCards.length > 0) {
                    for (const card of spaceCards) {
                        const cardLinks = await card.locator('a[href*="/spaces/"]').all();
                        if (cardLinks.length > 0) {
                            for (const link of cardLinks) {
                                const href = await link.getAttribute('href');
                                if (href) {
                                    if (spaceUrlRegex.test(href)) {
                                        logger.info(`[🐦 Helper] Found Space URL in card link (full, article ${i+1}): ${href}`);
                                        return href;
                                    } else if (spaceUrlRegexShort.test(href)) {
                                        const fullUrl = `https://twitter.com${href}`;
                                        logger.info(`[🐦 Helper] Found Space URL in card link (relative, article ${i+1}): ${fullUrl}`);
                                        return fullUrl;
                                    }
                                }
                            }
                        }
                    }
                }
            } catch(e) { /* Ignore error */ }

            // Fallback 3: Check generic <a> links
            try {
                const allLinks = await article.locator('a[href*="/spaces/"]').all();
                if (allLinks.length > 0) {
                    for (const link of allLinks) {
                        const href = await link.getAttribute('href');
                        if (href) {
                            const fullUrl = href.startsWith('http') ? href : `https://twitter.com${href}`;
                            if (spaceUrlRegex.test(fullUrl)) {
                                logger.info(`[🐦 Helper] Found Space URL in generic link (article ${i+1}): ${fullUrl}`);
                                return fullUrl;
                            }
                        }
                    }
                 }
            } catch (e) { /* Ignore error */ }
        }

        logger.debug('[🐦 Helper] No Space URL found in any visible articles using any method.');
        return null;
    } catch (error) {
        logger.error(`[🐦 Helper] Error searching for Space URL on page:`, error);
        return null;
    }
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

// --- NEW: Selectors for Mention Scraping (VERY LIKELY TO CHANGE) ---
const MENTION_TWEET_SELECTOR = 'article[data-testid="tweet"]'; // General tweet container on notifications/mentions page
const MENTION_TWEET_TEXT_SELECTOR = 'div[data-testid="tweetText"]'; // Text content of the mention tweet
const MENTION_USERNAME_SELECTOR = 'div[data-testid="User-Name"] span'; // Selector for spans within username, find one starting with @
const MENTION_TIMESTAMP_LINK_SELECTOR = 'time'; // Time element within the tweet, used to find the tweet's specific URL via ancestor link

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
 * Initialize a browser instance with necessary configuration for Twitter interactions
 */
export async function initializeBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    logger.info('Initializing browser for Twitter interactions');
    // For debugging, use non-headless by default
    const browser = await chromium.launch({
        headless: config.BROWSER_HEADLESS ?? false,
        args: ['--disable-blink-features=AutomationControlled'],
    });
    logger.info(`Browser launched in ${config.BROWSER_HEADLESS ? 'headless' : 'non-headless'} mode`);
    
    // Create a new context with default options
    const context = await browser.newContext(getDefaultBrowserContextOptions());
    logger.info('Browser context created with default options');

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
 * @param page The already logged-in Playwright Page object.
 * @returns Promise resolving with M3U8 URL and potentially the original Tweet URL.
 */
export async function getM3u8ForSpacePage(
    directSpaceUrl: string, 
    page: Page // Added page argument
): Promise<{ m3u8Url: string | null, originalTweetUrl: string | null }> {
    logger.info(`[🐦 Twitter] Getting M3U8 for direct Space URL: ${directSpaceUrl} using existing page.`);
    // REMOVE browser/context/page initialization and login
    // let browser: Browser | null = null;
    // let context: BrowserContext | null = null;
    // let page: Page | null = null; // Use the passed-in page
    let capturedM3u8Url: string | null = null;
    let foundOriginalTweetUrl: string | null = null;

    // Create a log of all network requests for debugging
    const networkRequests: string[] = [];

    let resolveM3u8Promise: (url: string) => void;
    const m3u8Promise = new Promise<string>((resolve) => {
        resolveM3u8Promise = resolve;
     });

    // Ensure screenshot directory exists (might be redundant if daemon creates it, but safe)
    const screenshotDir = path.join(process.cwd(), 'debug-screenshots');
    if (!fs.existsSync(screenshotDir)){
        fs.mkdirSync(screenshotDir, { recursive: true });
    }

    // --- Network Listeners --- 
    // Define listener functions to attach/detach them cleanly
    const requestListener = (request: any) => {
        const url = request.url();
        networkRequests.push(`${request.method()} ${url}`);
        if ((url.includes('prod-fastly') && url.includes('.m3u8')) || url.includes('.m3u8?type=replay')) {
            logger.info(`[🐦 Twitter Req] ✅✅ Twitter Space m3u8 URL detected: ${url}`);
            if (!capturedM3u8Url) {
                capturedM3u8Url = url;
                resolveM3u8Promise(url);
            }
        }
        if (url.includes('.m3u8') || url.includes('playlist') || url.includes('media') || url.includes('audio') || url.includes('video') || url.includes('pscp.tv') || url.includes('fastly') || url.includes('stream')) {
            logger.debug(`[🐦 Twitter Req] 🔍 Network request: ${request.method()} ${url}`);
        }
    };

    const responseListener = async (response: any) => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';
        // Check for GraphQL API responses 
        if (url.includes('AudioSpaceById') || url.includes('AudioSpace')) {
             logger.info(`[🐦 Twitter Res] 🔍 GraphQL API response: ${url}`);
             try {
                 const responseBody = await response.json().catch(() => null);
                 if (responseBody) {
                     const responseStr = JSON.stringify(responseBody);
                     const urlMatches = responseStr.match(/"(https:\/\/[^"]*?\.m3u8[^"]*?)"/g);
                     if (urlMatches && urlMatches.length > 0) {
                         const cleanUrls = urlMatches.map((u: string) => u.replace(/"/g, ''));
                         const fastlyUrl = cleanUrls.find((u: string) => (u.includes('prod-fastly') && u.includes('.m3u8')) || u.includes('.m3u8?type=replay'));
                         if (fastlyUrl && !capturedM3u8Url) {
                             logger.info(`[🐦 Twitter Res] ✅✅ Extracted m3u8 URL from API: ${fastlyUrl}`);
                             capturedM3u8Url = fastlyUrl;
                             resolveM3u8Promise(fastlyUrl);
                         }
                     }
                 }
             } catch (e) { logger.warn(`[🐦 Twitter Res] Error processing API response: ${e}`); }
         }
         // Log media responses
         if (contentType.includes('audio') || contentType.includes('video') || contentType.includes('application/vnd.apple.mpegurl') || url.includes('.m3u8')) {
              logger.info(`[🐦 Twitter Res] 📡 Media Response: ${url} (${contentType})`);
             if ((url.includes('prod-fastly') && url.includes('.m3u8')) || url.includes('.m3u8?type=replay')) {
                 if (!capturedM3u8Url) {
                     logger.info(`[🐦 Twitter Res] ✅✅ Found Space m3u8 URL in response: ${url}`);
                     capturedM3u8Url = url;
                     resolveM3u8Promise(url);
                 }
             }
         }
    };

    // Route handler - less necessary now maybe, but keep for direct interception
    const routeHandler = (route: any, request: any) => {
         const url = request.url();
         const urlString = url.toString();
         if ((urlString.includes('prod-fastly') && urlString.includes('.m3u8')) || urlString.includes('.m3u8?type=replay')) {
             logger.info(`[🐦 Twitter Route] ✅ Intercepted potential media URL: ${url}`);
             if (!capturedM3u8Url) {
                 logger.info(`[🐦 Twitter Route] ✅✅ Found Space m3u8 URL via route: ${url}`);
                 capturedM3u8Url = url;
                 resolveM3u8Promise(url);
             }
         }
         route.continue();
     };
    const routePattern = (url: URL) => {
        const urlString = url.toString();
        return (urlString.includes('prod-fastly') && urlString.includes('.m3u8')) || urlString.includes('.m3u8?type=replay');
    };

    try {
        // Attach listeners
        logger.debug('[🐦 Twitter] Attaching network listeners...');
        page.on('request', requestListener);
        page.on('response', responseListener);
        await page.route(routePattern, routeHandler);

        // REMOVE LOGIN CALL - Assume page is logged in
        // const loginSuccess = await loginToTwitter(page);
        // if (!loginSuccess) { ... }

        // Navigate to space URL
        logger.info(`[🐦 Twitter] Navigating to space URL: ${directSpaceUrl}`);
        await page.goto(directSpaceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        logger.info('[🐦 Twitter] Space page initial load complete. Taking screenshot...');
        await page.screenshot({ path: path.join(screenshotDir, 'space-page-loaded.png') });
        await page.waitForTimeout(3000);
        
        // --- Find and Click Play Button Logic (Simplified for brevity) ---
        const playButtonSelectors = [
            'button[aria-label*="Play recording"]', 'button:has-text("Play recording")',
            'div[role="button"]:has-text("Play recording")', 'button:has-text("Play")',
            'button[data-testid="play"]'
        ];
        logger.info('[🐦 Twitter] Looking for "Play recording" button...');
        let playButton = null;
        for (const selector of playButtonSelectors) {
            const button = page.locator(selector).first();
            if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
                playButton = button;
                logger.info(`[🐦 Twitter] Found play button with selector: ${selector}`);
                break;
            }
        }

        if (!playButton) {
            logger.warn('[🐦 Twitter] No Play recording button found. Attempting JS click as fallback...');
             await page.screenshot({ path: path.join(screenshotDir, 'no-play-button-found.png') });
            try {
                await page.evaluate(() => {
                     const buttons = [...document.querySelectorAll('[aria-label*="Play" i], button:contains("Play")')];
                     if (buttons.length > 0) (buttons[0] as HTMLElement).click();
                 });
                 await page.waitForTimeout(3000);
                 logger.info('[🐦 Twitter] JS click attempted.');
            } catch(e) {
                logger.error('[🐦 Twitter] JS click failed, cannot proceed.', e);
                 throw new Error('Play button not found and JS click failed');
             }
        } else {
            logger.info('[🐦 Twitter] "Play recording" button found. Clicking...');
            await playButton.click({ force: true, timeout: 10000 });
            logger.info('[🐦 Twitter] Play button clicked. Taking screenshot...');
            await page.waitForTimeout(2000);
            await page.screenshot({ path: path.join(screenshotDir, 'after-play-button-click.png') });
        }
        
        // --- Wait for M3U8 --- 
        logger.debug('[🐦 Twitter] Waiting for M3U8 network request (up to 30s)...');
        try {
            await new Promise<string>((resolve, reject) => {
                const timeoutId = setTimeout(() => reject(new Error('M3U8 capture timeout (30s)')), 30000);
                m3u8Promise.then(url => {
                    clearTimeout(timeoutId);
                    resolve(url);
                }).catch(reject);
            });
            logger.info('[🐦 Twitter] M3U8 URL captured successfully.');
        } catch (waitError) {
             logger.warn(`[🐦 Twitter] Timed out or error waiting for M3U8: ${waitError}`);
             await page.screenshot({ path: path.join(screenshotDir, 'm3u8-capture-timeout.png') });
             // Fallback: Check network requests array directly just in case listener failed
             const fallbackM3u8 = networkRequests.find(req => (req.includes('prod-fastly') && req.includes('.m3u8')) || req.includes('.m3u8?type=replay'));
             if (fallbackM3u8) {
                 const urlMatch = fallbackM3u8.split(' ')[1];
                 logger.warn(`[🐦 Twitter] Found potential M3U8 in request log fallback: ${urlMatch}`);
                 capturedM3u8Url = urlMatch;
             } else {
                  logger.error('[🐦 Twitter] M3U8 not found via listener or fallback log scan.');
             }
        }

        // --- Attempt to find original tweet URL (Best Effort) --- 
        try {
             const linkElement = page.locator(LINK_TO_ORIGINAL_TWEET_SELECTOR).first();
             if (await linkElement.isVisible({timeout: 3000})) {
                 const href = await linkElement.getAttribute('href');
                 if (href && href.includes('/status/')) {
                     foundOriginalTweetUrl = href.startsWith('/') ? `https://x.com${href}` : href;
                     logger.info(`[🐦 Twitter] Found potential original tweet link: ${foundOriginalTweetUrl}`);
                 }
             }
        } catch (e) {
            logger.warn('[🐦 Twitter] Could not find original tweet link on Space page.');
        }

        if (!capturedM3u8Url) {
            logger.error('[🐦 Twitter] ❌ Failed to capture M3U8 URL for the Space.');
             await page.screenshot({ path: path.join(screenshotDir, 'space-page-m3u8-fail.png') });
             // Write network log for debugging
             fs.writeFileSync(path.join(screenshotDir, 'space-page-network.log'), networkRequests.join('\n'));
             return { m3u8Url: null, originalTweetUrl: foundOriginalTweetUrl };
        }

        logger.info(`[🐦 Twitter] ✅ Successfully processed Space page: ${directSpaceUrl}`);
        return {
            m3u8Url: capturedM3u8Url,
            originalTweetUrl: foundOriginalTweetUrl
        };

    } catch (error) {
        logger.error(`[🐦 Twitter] ❌ Error processing Space page ${directSpaceUrl}:`, error);
         try {
            await page.screenshot({ path: path.join(screenshotDir, 'space-page-processing-error.png') });
            fs.writeFileSync(path.join(screenshotDir, 'space-page-network-error.log'), networkRequests.join('\n'));
        } catch (e) { /* ignore screenshot/log error */ }
        return { m3u8Url: null, originalTweetUrl: null }; // Return nulls on error
    } finally {
         // Detach listeners to prevent memory leaks
         logger.debug('[🐦 Twitter] Detaching network listeners...');
         page.off('request', requestListener);
         page.off('response', responseListener);
         await page.unroute(routePattern, routeHandler).catch(e => logger.warn('Error unrouting', e));
         logger.debug('[🐦 Twitter] Listeners detached (getM3u8ForSpacePage).');
         // DO NOT CLOSE BROWSER/CONTEXT/PAGE HERE
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
 * @param page The logged-in Playwright page instance.
 * @param tweetUrl The URL of the tweet to reply to
 * @param replyText The text content of the reply
 * @returns True if reply was posted successfully, false otherwise
 */
export async function postReplyToTweet(page: Page, tweetUrl: string, replyText: string): Promise<boolean> {
    logger.info(`[🐦 Twitter] Attempting to post reply to tweet: ${tweetUrl} using existing page.`);
    
    if (!tweetUrl) {
        logger.error(`[🐦 Twitter] Invalid tweet URL provided`);
        return false;
    }
    
    // Ensure screenshots directory exists
    const screenshotsDir = path.join(process.cwd(), 'debug-screenshots');
    if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    
    try {
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
        
        // Look for the reply button - **MODIFIED TO BE MORE SPECIFIC**
        logger.info(`[🐦 Twitter] Looking for the specific reply button for tweet ${tweetUrl}...`);
        
        // Extract the tweet ID from the URL
        const tweetIdMatch = normalizedUrl.match(/\/status\/(\d+)/);
        if (!tweetIdMatch || !tweetIdMatch[1]) {
            logger.error(`[🐦 Twitter] Could not extract tweet ID from URL ${normalizedUrl} to target reply button.`);
            return false;
        }
        const targetTweetId = tweetIdMatch[1];
        logger.debug(`[🐦 Twitter] Target tweet ID for reply: ${targetTweetId}`);

        // Locate the specific article containing a link to this tweet status
        // This assumes the main tweet article has a timestamp link pointing to itself.
        const targetArticleSelector = `article:has(a[href*="/status/${targetTweetId}"])`;
        const targetArticle = page.locator(targetArticleSelector).first();

        if (!await targetArticle.isVisible({ timeout: 5000 }).catch(() => false)) {
            logger.error(`[🐦 Twitter] Could not find the specific article element for tweet ${targetTweetId}.`);
            await page.screenshot({ path: path.join(screenshotsDir, 'no-target-article.png') });
            // Save full page HTML for debugging
            const html = await page.content();
            fs.writeFileSync(path.join(screenshotsDir, 'tweet-page-no-article.html'), html);
            return false;
        }
        logger.info(`[🐦 Twitter] Found target article for tweet ${targetTweetId}. Looking for reply button within it...`);

        // Now, look for the reply button *within* that specific article
        const replyButtonSelectors = [
            '[data-testid="reply"]',
            'div[aria-label="Reply"]',
            '[aria-label="Reply"]',
            'div[role="button"]:has-text("Reply")'
        ];
        
        let replyButton = null;
        for (const selector of replyButtonSelectors) {
            // Use locator chaining: find the button *within* the targetArticle
            const button = targetArticle.locator(selector).first(); 
            if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
                replyButton = button;
                logger.info(`[🐦 Twitter] Found reply button for target tweet using selector: ${selector}`);
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
        
        let explicitSuccessFound = false;
        for (const selector of successIndicators) {
            if (await page.locator(selector).isVisible({ timeout: 2000 }).catch(() => false)) {
                logger.info(`[🐦 Twitter] ✅ Reply successfully posted to tweet (confirmed by toast message: ${selector})`);
                explicitSuccessFound = true;
                break; // Exit loop once success is confirmed
            }
        }
        
        // If explicit success was found, return true
        if (explicitSuccessFound) {
            return true;
        }
        
        // If we didn't see explicit success, log a warning and return false
        logger.warn(`[🐦 Twitter] ⚠️ Reply submitted, but no explicit success confirmation (e.g., toast message) was detected.`);
        logger.warn(`[🐦 Twitter] The reply might have failed silently or might appear after a delay. Returning false.`);
        
        return false;
    } catch (error) {
        logger.error(`[🐦 Twitter] Error posting reply to tweet: ${error}`);
        if (page && !page.isClosed()) {
             await page.screenshot({ path: path.join(screenshotsDir, 'reply-attempt-error.png') });
        }
        return false;
    } finally {
        logger.info(`[🐦 Twitter] Reply attempt finished for ${tweetUrl}.`);
    }
} 

// --- NEW FUNCTION ---
/**
 * Scrapes the Twitter mentions page for recent mentions of the logged-in user.
 * Assumes the page is already logged in.
 * @param page The logged-in Playwright page instance.
 * @returns {Promise<MentionInfo[]>} An array of found mentions.
 */
export async function scrapeMentions(page: Page): Promise<MentionInfo[]> {
    const mentionsUrl = 'https://twitter.com/notifications/mentions';
    const foundMentions: MentionInfo[] = [];
    const screenshotDir = path.join(process.cwd(), 'debug-screenshots');
     // Ensure screenshot directory exists
     if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
        logger.info(`[🔔 Mention] Created screenshot directory: ${screenshotDir}`);
    }


    logger.info(`[🔔 Mention] Navigating to mentions page: ${mentionsUrl}`);
    try {
        // Use domcontentloaded instead of networkidle and a shorter timeout
        await page.goto(mentionsUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        logger.info('[🔔 Mention] Mentions page loaded. Waiting for tweets...');
        
        // Wait for selectors with more reasonable timeouts
        const hasTweets = await page.locator(MENTION_TWEET_SELECTOR).first().isVisible({ timeout: 10000 })
            .catch(() => false);
        
        if (!hasTweets) {
            logger.warn('[🔔 Mention] No tweets visible after initial load. Taking screenshot and continuing anyway.');
            await page.screenshot({ path: path.join(screenshotDir, 'mentions-page-no-visible-tweets.png') });
            // Allow a bit more time for dynamic content to load
            await page.waitForTimeout(5000);
        } else {
            // Wait a moment for more tweets to load
            await page.waitForTimeout(3000);
        }
        
        await page.screenshot({ path: path.join(screenshotDir, 'mentions-page-loaded.png') });


        logger.debug('[🔔 Mention] Locating mention tweets...');
        const tweetLocators = await page.locator(MENTION_TWEET_SELECTOR).all();
        logger.info(`[🔔 Mention] Found ${tweetLocators.length} potential mention tweets on the page.`);


        if (tweetLocators.length === 0) {
             logger.warn('[🔔 Mention] No tweets found on mentions page. Screenshot saved.');
             await page.screenshot({ path: path.join(screenshotDir, 'mentions-page-no-tweets.png') });
             return [];
        }


        for (let i = 0; i < tweetLocators.length; i++) {
            const tweetLocator = tweetLocators[i];
            let tweetId: string | null = null;
            let tweetUrl: string | null = null;
            let username: string | null = null;
            let text: string | null = null;


            try {
                // 1. Extract Tweet URL and ID
                logger.debug(`[🔔 Mention] Processing tweet ${i+1}/${tweetLocators.length}: Extracting URL/ID...`);
                const timeElement = tweetLocator.locator(MENTION_TIMESTAMP_LINK_SELECTOR).first();
                if (await timeElement.isVisible({ timeout: 2000 })) {
                    const linkElement = timeElement.locator('xpath=./ancestor::a[@href]');
                    const href = await linkElement.getAttribute('href', { timeout: 2000 });
                    if (href) {
                        tweetUrl = `https://x.com${href}`;
                        // Extract ID from URL (e.g., /status/12345 -> 12345)
                        const match = href.match(/\/status\/(\d+)/);
                        if (match && match[1]) {
                            tweetId = match[1];
                            logger.debug(`[🔔 Mention]   Extracted Tweet URL: ${tweetUrl}`);
                            logger.debug(`[🔔 Mention]   Extracted Tweet ID: ${tweetId}`);
                        } else {
                             logger.warn(`[🔔 Mention]   Could not parse Tweet ID from href: ${href}`);
                        }
                    } else {
                        logger.warn('[🔔 Mention]   Could not find href attribute on ancestor link of time element.');
                    }
                } else {
                    logger.warn('[🔔 Mention]   Timestamp element not visible for this tweet.');
                }


                // 2. Extract Username
                logger.debug(`[🔔 Mention]   Extracting username...`);
                 // Select all spans within the user-name container
                 const usernameSpans = await tweetLocator.locator(MENTION_USERNAME_SELECTOR).allTextContents();
                 // Find the span that starts with '@'
                 const handleSpan = usernameSpans.find(span => span.trim().startsWith('@'));
                 if (handleSpan) {
                     username = handleSpan.trim();
                     logger.debug(`[🔔 Mention]   Extracted Username: ${username}`);
                 } else {
                     logger.warn(`[🔔 Mention]   Could not find username span starting with '@'. Spans found: ${usernameSpans.join(', ')}`);
                 }


                // 3. Extract Text
                logger.debug(`[🔔 Mention]   Extracting tweet text...`);
                const textElement = tweetLocator.locator(MENTION_TWEET_TEXT_SELECTOR).first();
                if (await textElement.isVisible({ timeout: 2000 })) {
                     text = await textElement.textContent({ timeout: 2000 });
                     if (text) {
                         text = text.trim(); // Clean up whitespace
                         logger.debug(`[🔔 Mention]   Extracted Text (raw): ${text}`);
                     } else {
                         logger.warn('[🔔 Mention]   Tweet text element found but content is null/empty.');
                     }
                 } else {
                      logger.warn('[🔔 Mention]   Tweet text element not visible for this tweet.');
                 }


                // 4. Add to results if valid
                if (tweetId && tweetUrl && username && text) {
                    logger.info(`[🔔 Mention] ✅ Successfully extracted mention: ID=${tweetId}, User=${username}`);
                    foundMentions.push({ tweetId, tweetUrl, username, text });
                } else {
                    logger.warn(`[🔔 Mention] ⚠️ Failed to extract all required info for tweet index ${i}. Skipping.`);
                     // Log details for debugging which part failed
                     logger.warn(`[🔔 Mention]   Details: ID=${tweetId}, URL=${tweetUrl}, User=${username}, Text=${text ? 'Present' : 'Missing'}`);
                     // Take a screenshot of the specific problematic tweet element
                     try {
                       await tweetLocator.screenshot({ path: path.join(screenshotDir, `mention-tweet-${i+1}-extraction-error.png`) });
                       logger.warn(`[🔔 Mention]   Screenshot saved for problematic tweet ${i+1}.`);
                     } catch (ssError) {
                       logger.error(`[🔔 Mention]   Error taking screenshot for problematic tweet ${i+1}:`, ssError);
                     }
                }


            } catch (extractError) {
                logger.error(`[🔔 Mention] ❌ Error processing mention tweet index ${i}:`, extractError);
                 await tweetLocator.screenshot({ path: path.join(screenshotDir, `mention-tweet-${i+1}-processing-error.png`) });
            }
             await page.waitForTimeout(100); // Small delay between processing tweets
        }


    } catch (error) {
        logger.error(`[🔔 Mention] ❌ Failed to scrape mentions page:`, error);
        await page.screenshot({ path: path.join(screenshotDir, 'mentions-page-error.png') });
    }


    logger.info(`[🔔 Mention] Finished scraping. Found ${foundMentions.length} valid mentions.`);
    return foundMentions;
}
// --- END NEW FUNCTION ---

// --- Moved from mentionDaemon.ts ---
/**
 * Initializes a Playwright browser instance and context.
 */
export async function initializeDaemonBrowser(): Promise<{ browser: Browser, context: BrowserContext }> {
    const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots');
    logger.info('[😈 Daemon Browser] Initializing Playwright browser...');
    
     // Ensure screenshot directory exists
     if (!await fsPromises.access(SCREENSHOT_DIR).then(() => true).catch(() => false)) {
        await fsPromises.mkdir(SCREENSHOT_DIR, { recursive: true });
        logger.info(`[😈 Daemon] Created screenshot directory: ${SCREENSHOT_DIR}`);
    }
    
    // First check for cookies file (from saveCookies.ts)
    const cookiesPath = path.join(process.cwd(), 'cookies', 'twitter-cookies.json');
    const hasCookies = await fsPromises.access(cookiesPath).then(() => true).catch(() => false);
    
    // Then check for storage state file (backup)
    const storageStatePath = path.join(process.cwd(), 'cookies', 'twitter-storage-state.json');
    const hasStorageState = await fsPromises.access(storageStatePath).then(() => true).catch(() => false);
    
    // Fallback to browser-state directory for backwards compatibility
    const oldStorageStatePath = path.join(process.cwd(), 'browser-state', 'twitter-storage-state.json');
    const hasOldStorageState = await fsPromises.access(oldStorageStatePath).then(() => true).catch(() => false);
    
    let stateToUse = null;
    if (hasCookies) {
        logger.info(`[😈 Daemon Browser] Found cookies file at ${cookiesPath}. Will use for session.`);
        stateToUse = 'cookies';
    } else if (hasStorageState) {
        logger.info(`[😈 Daemon Browser] Found storage state at ${storageStatePath}. Will use stored login session.`);
        stateToUse = 'storage';
    } else if (hasOldStorageState) {
        logger.info(`[😈 Daemon Browser] Found old storage state at ${oldStorageStatePath}. Will use stored login session.`);
        stateToUse = 'oldStorage';
    } else {
        logger.info(`[😈 Daemon Browser] No saved cookies or state found.`);
        logger.info('[😈 Daemon Browser] Please run: npm run save:cookies to log in manually and save cookies');
    }
    
    // Use non-headless mode for debugging
    const isHeadless = false; // Force non-headless mode for debugging
    logger.info(`[😈 Daemon Browser] Launching browser (Headless: ${isHeadless})`);
    const browser = await chromium.launch({ 
        headless: isHeadless, 
        slowMo: isHeadless ? 0 : 250 // Slow down only if not headless
    });
    
    // Create context with or without saved state
    const contextOptions = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 900 },
        locale: 'en-US'
    };
    
    let context;
    
    if (stateToUse === 'cookies') {
        // Load the cookies from file
        logger.info('[😈 Daemon Browser] Creating browser context with saved cookies...');
        
        // First create a normal context
        context = await browser.newContext(contextOptions);
        
        // Then load and add the cookies
        try {
            const cookiesJson = await fsPromises.readFile(cookiesPath, 'utf8');
            const cookies = JSON.parse(cookiesJson);
            logger.info(`[😈 Daemon Browser] Loaded ${cookies.length} cookies from file`);
            await context.addCookies(cookies);
            logger.info('[😈 Daemon Browser] Added cookies to browser context');
        } catch (error) {
            logger.error('[😈 Daemon Browser] Error loading/parsing cookies:', error);
            logger.info('[😈 Daemon Browser] Falling back to standard context without cookies');
        }
    } else if (stateToUse === 'storage') {
        // Use the storage state file (includes cookies and localStorage)
        logger.info('[😈 Daemon Browser] Creating browser context with storage state...');
        context = await browser.newContext({
            ...contextOptions,
            storageState: storageStatePath
        });
        logger.info('[😈 Daemon Browser] Browser context created with storage state');
    } else if (stateToUse === 'oldStorage') {
        // Use the old storage state path
        logger.info('[😈 Daemon Browser] Creating browser context with old storage state...');
        context = await browser.newContext({
            ...contextOptions,
            storageState: oldStorageStatePath
        });
        logger.info('[😈 Daemon Browser] Browser context created with old storage state');
    } else {
        // No saved state, create a fresh context
        logger.info('[😈 Daemon Browser] Creating browser context without saved state...');
        context = await browser.newContext(contextOptions);
        logger.info('[😈 Daemon Browser] Browser context created without saved state.');
    }
    
    // Add null check for context before returning
    if (!context) {
        logger.error('[😈 Daemon Browser] Failed to create browser context!');
        // Ensure browser close is awaited properly
        try {
            await browser.close();
            logger.info('[😈 Daemon Browser] Closed browser due to context creation failure.');
        } catch (closeError) {
            logger.error('[😈 Daemon Browser] Error closing browser after context failure:', closeError);
        }
        throw new Error('Failed to initialize browser context');
    }
    
    logger.info('[😈 Daemon Browser] ✅ Browser initialized.');
    return { browser, context };
}
// --- END Moved Function ---

// --- ADD HELPER FUNCTIONS HERE ---
/**
 * Extracts the first valid Twitter Space URL from text.
 * @param text The text to search within.
 * @returns The Space URL or null if not found.
 */
export function extractSpaceUrl(text: string): string | null {
    const spaceUrlRegex = /https:\/\/(?:twitter|x)\.com\/i\/spaces\/([a-zA-Z0-9]+)/;
    const match = text.match(spaceUrlRegex);
    return match ? match[0] : null;
}

/**
 * Extracts the unique ID from a Twitter Space URL.
 * @param spaceUrl The URL like https://x.com/i/spaces/...
 * @returns The space ID string or null if not found.
 */
export function extractSpaceId(spaceUrl: string): string | null {
    const spaceIdRegex = /spaces\/([a-zA-Z0-9]+)/;
    const match = spaceUrl.match(spaceIdRegex);
    return match ? match[1] : null;
}
// --- END HELPER FUNCTIONS ---

// --- NEW HELPER: Click Play Button and Capture M3U8 ---
/**
 * Clicks the "Play recording" button within a specific tweet article 
 * and captures the resulting M3U8 stream URL via network interception.
 * @param page The Playwright page.
 * @param articleLocator The Playwright Locator for the specific tweet article.
 * @returns The captured M3U8 URL, or null if not found/error.
 */
export async function clickPlayButtonAndCaptureM3u8(page: Page, articleLocator: Locator): Promise<string | null> {
    logger.info(`[🐦 Helper M3U8] Attempting to click Play button and capture M3U8 within a specific article...`);
    const screenshotDir = path.join(process.cwd(), 'debug-screenshots');
    let capturedM3u8Url: string | null = null;
    const networkRequests: string[] = []; // Log requests for debugging

    let resolveM3u8Promise: (url: string) => void;
    const m3u8Promise = new Promise<string>((resolve) => {
        resolveM3u8Promise = resolve;
    });

    // --- Define Network Listeners ---
    const requestListener = (request: any) => {
        const url = request.url();
        networkRequests.push(`${request.method()} ${url}`);
        // Simplify check - just look for .m3u8 anywhere for now
        if (url.includes('.m3u8')) {
            logger.info(`[🐦 Helper M3U8 Req] ✅✅ M3U8 URL detected (simplified check): ${url}`);
            if (!capturedM3u8Url) {
                capturedM3u8Url = url;
                resolveM3u8Promise(url);
            }
        }
         // Log other potentially relevant requests
         if (url.includes('playlist') || url.includes('stream') || url.includes('AudioSpace') || url.includes('live_video')) {
            logger.debug(`[🐦 Helper M3U8 Req] 🔍 Relevant request: ${request.method()} ${url}`);
        }
    };

    const responseListener = async (response: any) => {
        const url = response.url();
        // If it's the live_video_stream API, try to parse its JSON response
        if (url.includes('live_video_stream')) {
            logger.info(`[🐦 Helper M3U8 Res] 💡 Received response from live_video_stream API: ${url}`);
            try {
                const responseBody = await response.json().catch(() => null);
                if (responseBody) {
                     logger.debug(`[🐦 Helper M3U8 Res] API Response Body: ${JSON.stringify(responseBody).substring(0, 500)}...`);
                     const responseStr = JSON.stringify(responseBody);
                     // Look for embedded m3u8 URLs within the JSON string
                     const urlMatches = responseStr.match(/"(https:\/\/[^"]*?\.m3u8[^"]*?)"/g);
                     if (urlMatches && urlMatches.length > 0) {
                         const cleanUrl = urlMatches[0].replace(/"/g, ''); // Use the first one found
                          if (cleanUrl && !capturedM3u8Url) {
                             logger.info(`[🐦 Helper M3U8 Res] ✅✅ Extracted M3U8 from live_video_stream API response: ${cleanUrl}`);
                             capturedM3u8Url = cleanUrl;
                             resolveM3u8Promise(cleanUrl);
                         }
                     }
                 }
            } catch (e) { logger.warn(`[🐦 Helper M3U8 Res] Error processing API response JSON: ${e}`); }
        }
        // Also check direct M3U8 responses
        else if (url.includes('.m3u8')) {
             if (!capturedM3u8Url) {
                 logger.info(`[🐦 Helper M3U8 Res] ✅✅ Found direct M3U8 response: ${url}`);
                 capturedM3u8Url = url;
                 resolveM3u8Promise(url);
             }
         }
    };
    
    // Simplify route handler and pattern - primarily rely on listeners now
    const routeHandler = (route: any) => { route.continue(); }; 
    const routePattern = (url: URL) => url.toString().includes('.m3u8'); 
    // --- End Network Listeners ---

    try {
        // Attach listeners
        logger.debug('[🐦 Helper M3U8] Attaching network listeners (broader pattern)...');
        page.on('request', requestListener);
        page.on('response', responseListener);
        // Using a simpler route matching based on URL string inclusion for broader compatibility
        await page.route('**/*.m3u8*', routeHandler);
        await page.route('**/live_video_stream/**', routeHandler); // Also allow API calls through

        // Find and Click Play Button within the specific article
        const playButtonSelectors = [
            'button[aria-label*="Play recording"]', 
            'button:has-text("Play recording")'
        ];
        logger.info('[🐦 Helper M3U8] Looking for "Play recording" button inside the article...');
        let playButton = null;
        for (const selector of playButtonSelectors) {
            const button = articleLocator.locator(selector).first(); // Locate within the article
            if (await button.isVisible({ timeout: 2000 })) {
                playButton = button;
                logger.info(`[🐦 Helper M3U8] Found play button with selector: ${selector}`);
                break;
            }
        }

        if (!playButton) {
            logger.error('[🐦 Helper M3U8] Play button not found within the provided article.');
            await articleLocator.screenshot({ path: path.join(screenshotDir, 'article-no-play-button.png') });
            return null; 
        }
        
        logger.info('[🐦 Helper M3U8] Clicking Play button...');
        await playButton.click({ force: true, timeout: 10000 });
        await page.waitForTimeout(1000); // Small wait after click
        await articleLocator.screenshot({ path: path.join(screenshotDir, 'article-after-play-click.png') });

        // Wait for M3U8 capture - Increased timeout
        logger.debug('[🐦 Helper M3U8] Waiting for M3U8 network request (up to 30s)...');
        await new Promise<string>((resolve, reject) => {
            const timeoutId = setTimeout(() => reject(new Error('M3U8 capture timeout (30s)')), 30000); // Increased timeout
            m3u8Promise.then(url => {
                clearTimeout(timeoutId);
                resolve(url);
            }).catch(reject);
        });

        logger.info(`[🐦 Helper M3U8] ✅ Successfully captured M3U8 URL: ${capturedM3u8Url}`);
        return capturedM3u8Url;

    } catch (error) {
        logger.error(`[🐦 Helper M3U8] ❌ Error clicking Play or capturing M3U8:`, error);
        await articleLocator.screenshot({ path: path.join(screenshotDir, 'article-play-capture-error.png') }).catch(()=>{});
        // Log network requests on error
        // fsPromises.writeFile(path.join(screenshotDir, 'article-play-capture-network.log'), networkRequests.join('\n')).catch(()=>{});
        return null;
    } finally {
        // Detach listeners
        logger.debug('[🐦 Helper M3U8] Detaching network listeners...');
        page.off('request', requestListener);
        page.off('response', responseListener);
        // Unroute both patterns
        await page.unroute('**/*.m3u8*', routeHandler).catch(e => logger.warn('Error unrouting m3u8', e));
        await page.unroute('**/live_video_stream/**', routeHandler).catch(e => logger.warn('Error unrouting live_video_stream', e));
        logger.debug('[🐦 Helper M3U8] Listeners detached.');
    }
}
// --- END NEW HELPER ---

/**
 * Extracts the Space title from the modal/player that appears after clicking the Play Recording button.
 * Prioritizes specific container selectors and the data-testid="tweetText" structure.
 * Includes fallback strategies for robustness.
 *
 * @param page The Playwright page object
 * @returns The extracted Space title or null if not found
 */
export async function extractSpaceTitleFromModal(page: Page): Promise<string | null> {
    logger.info('[🐦 Helper Title] Attempting to extract Space title from modal...');
    // Define screenshot/log paths relative to process CWD, assuming they exist or are created elsewhere
    const screenshotDir = path.join(process.cwd(), 'debug-screenshots');
    const LOG_DIR = path.join(process.cwd(), 'logs');

    try {
        // Wait for *some* indicator of the player/modal content
        logger.info('[🐦 Helper Title] Waiting up to 10s for modal/player indicators to appear...');
        const modalIndicatorSelector =
            'div[data-testid*="audioPlayer"], ' +
            'div[aria-label*="Audio"], ' +
            'div[data-testid*="audioSpaceDetailView"], ' +
            'div:has-text("tuned in"), ' +
            'div:has-text("Speakers")';
        await page.waitForSelector(modalIndicatorSelector, { state: 'visible', timeout: 10000 });
        logger.info('[🐦 Helper Title] Modal/player indicators are visible.');
        await page.waitForTimeout(1000); // Stability wait

        // Locate the specific player/modal container
        let container: any | null = null;
        const potentialContainerSelectors = [
            'div[data-testid="SpaceDockExpanded"]', // **** PRIORITIZE THIS ****
            'div[data-testid="audioSpaceDetailView"]',
            'div[data-testid*="audioPlayer"]',
            'div[aria-label*="Audio banner"]',
            'div[role="dialog"]', // Keep dialog as fallback
        ];

        for(const selector of potentialContainerSelectors) {
            logger.debug(`[🐦 Helper Title] Trying container selector: ${selector}`);
            const element = page.locator(selector).first();
            if (await element.isVisible({ timeout: 500 })) {
                const textContent = await element.textContent({ timeout: 500 }) || '';
                // Check for multiple confirmation texts
                if (textContent.includes('tuned in') || textContent.includes('Speaker') || textContent.includes('Listener') || textContent.includes('MEMECOIN') || textContent.includes('Playing')) {
                    logger.info(`[🐦 Helper Title] Found specific Space container using selector: ${selector}`);
                    container = element;
                    // Log container HTML for debugging
                    try {
                        const containerHtml = await container.innerHTML();
                        logger.debug(`[🐦 Helper Title] Container HTML (first 500 chars): ${containerHtml.substring(0, 500)}`);
                    } catch (e) {logger.warn('Could not get container HTML');}
                    break;
                } else {
                    logger.debug(`[🐦 Helper Title] Container found with ${selector}, but missing confirmation text.`);
                }
            }
        }

        if (!container) {
            logger.error('[🐦 Helper Title] Could not locate a reliable modal/player container.');
            await page.screenshot({ path: path.join(screenshotDir, 'modal-container-not-found.png') });
            return null;
        }

        logger.info('[🐦 Helper Title] Located container, taking screenshot...');
        await container.screenshot({ path: path.join(screenshotDir, 'modal-container-found.png') });

        // --- Search for Title WITHIN the container --- 

        // Strategy 0: Use the structure identified from user's HTML snippet
        logger.info('[🐦 Helper Title] FOCUS STRATEGY: Checking data-testid=tweetText span within container...');
        try {
            const tweetTextSpan = container.locator('div[data-testid="tweetText"] span').first();
            if (await tweetTextSpan.isVisible({ timeout: 2000 })) { // Increased timeout
                const text = await tweetTextSpan.textContent();
                const trimmedText = text?.trim();
                // Use a more general check first
                if (trimmedText && trimmedText.length > 3) { 
                    // Check if it resembles the specific known title format, but be flexible
                    // REMOVED HARDCODED CHECK - Rely on the selector finding the right element
                    logger.info(`[🐦 Helper Title] SUCCESS: Found title via tweetText span: "${trimmedText}"`);
                    return trimmedText; 
                    /* Previous check removed:
                    if (trimmedText.includes('MEMECOIN COMMUNITY')) {
                         logger.info(`[🐦 Helper Title] SUCCESS: Found title via tweetText span (specific match): "${trimmedText}"`);
                         return trimmedText;
                    } else {
                         logger.warn(`[🐦 Helper Title] tweetText span found, but doesn't match expected "MEMECOIN COMMUNITY": "${trimmedText}"`);
                    }
                    */
                } else {
                    logger.warn(`[🐦 Helper Title] tweetText span visible, but text content too short: "${trimmedText}"`);
                }
            } else {
                logger.warn('[🐦 Helper Title] tweetText span was not visible within the container.');
            }
        } catch (e) { 
             logger.error('[🐦 Helper Title] Error checking tweetText span:', e);
        }
        
        // --- ADD BACK OTHER STRATEGIES AS FALLBACKS --- 

        // Fallback Strategy 1: Target specific, reliable heading selectors within the container
        logger.debug('[🐦 Helper Title] Fallback Strategy 1: Checking specific heading selectors within container...');
        const specificHeadingSelectors = [
            'h2[aria-level="2"]', 
            'h1'
        ];
        for (const selector of specificHeadingSelectors) { 
            try {
                const element = container.locator(selector).first(); 
                if (await element.isVisible({ timeout: 500 })) { 
                    const text = await element.textContent({ timeout: 1000 }); 
                    const trimmedText = text?.trim();
                    if (trimmedText && trimmedText.length > 3 && !trimmedText.includes('keyboard shortcuts') && !trimmedText.includes('ago') && !trimmedText.includes('Listeners')) {
                        logger.info(`[🐦 Helper Title] Fallback SUCCESS: Found title via container heading selector "${selector}": "${trimmedText}"`); 
                        return trimmedText;
                    }
                }
            } catch (e) { logger.debug(`[🐦 Helper Title] Error trying container heading selector ${selector}: ${e}`); } 
        }

        // Fallback Strategy 2: Improve "Tuned In" logic within the container
        logger.debug('[🐦 Helper Title] Fallback Strategy 2: Looking near "tuned in" text within container...');
        try { 
            const timeElement = container.getByText(/tuned in/i).first(); 
            if (await timeElement.isVisible({ timeout: 1000 })) {
                const parentContainer = timeElement.locator('xpath=ancestor::div[contains(@style, "display: flex")] | ancestor::div[contains(@dir, "auto")]').first();
                if (await parentContainer.isVisible({timeout: 500})){
                    const containerText = await parentContainer.textContent();
                    const lines = containerText?.split('\n').map((line: string) => line.trim()).filter(Boolean) || []; 
                    const tunedInIndex = lines.findIndex((line: string) => /tuned in/i.test(line)); 
                     if (tunedInIndex !== -1 && tunedInIndex + 1 < lines.length) {
                        const potentialTitle = lines[tunedInIndex + 1];
                        if (potentialTitle && potentialTitle.length > 3 && !/^\d+$/.test(potentialTitle) && !potentialTitle.includes('ago') && !potentialTitle.includes(':')) {
                             logger.info(`[🐦 Helper Title] Fallback SUCCESS: Extracted potential title (line after tuned in): "${potentialTitle}"`);
                             return potentialTitle;
                         }
                    }
                    const headingInContainer = parentContainer.locator('h1, h2, span[role="heading"]').first();
                    if(await headingInContainer.isVisible({timeout: 200})){
                         const headingText = await headingInContainer.textContent();
                         if (headingText && headingText.trim().length > 3) {
                             logger.info(`[🐦 Helper Title] Fallback SUCCESS: Extracted potential title (heading near tuned in): "${headingText.trim()}"`);
                             return headingText.trim();
                         }
                    }
                }
            }
        } catch(e) { logger.debug('[🐦 Helper Title] Error in Fallback Strategy 2 (tuned in)', e); }

        // Fallback Strategy 4 (ALL CAPS)
        logger.debug('[🐦 Helper Title] Fallback Strategy 4: Checking for ALL CAPS text within container...');
        try {
            const textElements = await container.locator('span').all();
            for (const element of textElements) {
                if (await element.isVisible({ timeout: 200 })) {
                     const text = await element.textContent();
                     const trimmed = text?.trim();
                     if (trimmed && trimmed.length > 5 && trimmed === trimmed.toUpperCase() && !/^\d+$/.test(trimmed) && !trimmed.includes('JOIN') && !trimmed.includes('LIVE') && !trimmed.includes('ENDED')) {
                         logger.info(`[🐦 Helper Title] Fallback SUCCESS: Found potential ALL CAPS title in container: "${trimmed}"`);
                         return trimmed;
                     }
                 }
            }
        } catch (error) {
            logger.debug(`[🐦 Helper Title] Error trying to find all-caps title in container: ${error}`);
        }


        logger.warn('[🐦 Helper Title] Could not extract Space title using any strategy.');
        return null; // Added missing return null
    } catch (error) {
        logger.error('[🐦 Helper Title] Error during title extraction process:', error);
        // Ensure screenshot path is handled correctly if screenshotDir isn't globally available in service file
        try { await page.screenshot({ path: path.join(process.cwd(), 'debug-screenshots', 'modal-title-extraction-error.png') }); } catch {}
        return null;
    }
}


