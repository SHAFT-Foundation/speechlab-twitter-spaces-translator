import { config } from './utils/config';
import logger from './utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium, Browser, Page, BrowserContext, Locator } from 'playwright';
import { 
    scrapeMentions, 
    MentionInfo, 
    getM3u8ForSpacePage,
    postReplyToTweet,
    initializeDaemonBrowser,
    extractSpaceUrl, 
    extractSpaceId
} from './services/twitterInteractionService';
import { downloadAndUploadAudio } from './services/audioService';
import { createDubbingProject, waitForProjectCompletion, generateSharingLink } from './services/speechlabApiService';
import { v4 as uuidv4 } from 'uuid';

// --- Queue for Processing Mentions ---
const mentionQueue: MentionInfo[] = [];
let isProcessingQueue = false; // Flag to prevent concurrent worker runs
// --- END Queue ---

const PROCESSED_MENTIONS_PATH = path.join(process.cwd(), 'processed_mentions.json');
const POLLING_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots');
const MANUAL_LOGIN_WAIT_MS = 60 * 1000; // Wait 60 seconds for manual login if needed

/**
 * Logs into Twitter using provided credentials with an option for manual intervention.
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
        
        // First check - do we need manual intervention?
        logger.info('[😈 Daemon Login] Checking if manual login is required...');
        // Try automated login first
        const autoLoginSuccess = await attemptAutomatedLogin(page, username, password);
        
        if (autoLoginSuccess) {
            logger.info('[😈 Daemon Login] ✅ Automated login successful!');
            return true;
        }
        
        // If we get here, automated login failed - try manual intervention
        logger.warn('[😈 Daemon Login] 🔔 Automated login failed. Waiting for manual login intervention...');
        logger.warn(`[😈 Daemon Login] 🔔 PLEASE MANUALLY COMPLETE THE LOGIN IN THE BROWSER WINDOW. Waiting ${MANUAL_LOGIN_WAIT_MS/1000} seconds...`);
        
        // Take screenshot to help user
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-manual-login-requested.png') });
        
        // Wait for manual login
        let manualLoginSuccess = false;
        const startTime = Date.now();
        while (Date.now() - startTime < MANUAL_LOGIN_WAIT_MS) {
            // Check for login success indicators every 5 seconds
            await page.waitForTimeout(5000);
            
            // Try navigating to home
            try {
                logger.info('[😈 Daemon Login] Checking if manual login is complete...');
                await page.goto('https://twitter.com/home', { waitUntil: 'networkidle', timeout: 10000 });
                
                // Check login status
                for (const selector of ['[data-testid="AppTabBar_Home_Link"]', 'a[href="/home"]', '[data-testid="SideNav_NewTweet_Button"]', '[data-testid="primaryColumn"]']) {
                    if (await page.locator(selector).first().isVisible({ timeout: 2000 }).catch(() => false)) {
                        logger.info(`[😈 Daemon Login] ✅ Manual login successful! (indicator: ${selector})`);
                        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-manual-login-success.png') });
                        manualLoginSuccess = true;
                        break;
                    }
                }
                
                if (manualLoginSuccess) {
                    break;
                }
            } catch (navError) {
                logger.debug('[😈 Daemon Login] Navigation check error:', navError);
            }
        }
        
        if (manualLoginSuccess) {
            return true;
        }
        
        logger.error('[😈 Daemon Login] ❌ Manual login timed out or failed.');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-manual-login-failed.png') });
        return false;
    } catch (error) {
        logger.error('[😈 Daemon Login] ❌ Error during Twitter login:', error);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-login-exception.png') }).catch(()=>{}); // Best effort screenshot
        return false;
    }
}

/**
 * Helper function to attempt automated login
 */
async function attemptAutomatedLogin(page: Page, username: string, password: string): Promise<boolean> {
    try {
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

        // Check for unusual login activity verification
        const unusualActivityText = await page.getByText('Enter your phone number or email address', { exact: false }).isVisible({ timeout: 3000 }).catch(() => false);
        if (unusualActivityText) {
            logger.info('[😈 Daemon Login] Unusual login activity detected! Email verification required.');
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-unusual-activity.png') });
            
            // Look for the email/phone input field
            logger.debug('[😈 Daemon Login] Looking for email/phone verification field...');
            const verificationInput = await page.locator('input[name="text"], input[type="text"]').first();
            
            if (await verificationInput.isVisible({ timeout: 3000 })) {
                logger.info('[😈 Daemon Login] Verification input field found. Filling with email...');
                await verificationInput.click();
                await verificationInput.fill('');
                // Use the TWITTER_EMAIL if available, otherwise fallback to username
                const verificationEmail = config.TWITTER_EMAIL || config.TWITTER_USERNAME;
                logger.info(`[😈 Daemon Login] Using ${verificationEmail} for verification`);
                await verificationInput.fill(verificationEmail || '');
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-email-verification-filled.png') });
                
                // Look for the Next/Submit button
                logger.debug('[😈 Daemon Login] Looking for verification submit button...');
                const submitButton = await page.locator('div[role="button"]:has-text("Next"), button:has-text("Next"), div[role="button"]:has-text("Submit"), button:has-text("Submit")').first();
                
                if (await submitButton.isVisible({ timeout: 3000 })) {
                    logger.info('[😈 Daemon Login] Submit button found. Clicking...');
                    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-verification-submit-button.png') });
                    await submitButton.click();
                    await page.waitForTimeout(3000);
                    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-after-verification-submit.png') });
                } else {
                    logger.error('[😈 Daemon Login] Verification submit button not found.');
                    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-no-verification-submit.png') });
                    throw new Error('Verification submit button not found');
                }
            } else {
                logger.error('[😈 Daemon Login] Verification input field not found.');
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-no-verification-input.png') });
                throw new Error('Verification input field not found');
            }
        }

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

        // Check for suspicious login message and "Got it" button
        logger.info('[😈 Daemon Login] Checking for suspicious login message...');
        const suspiciousLoginText = await page.getByText('suspicious login prevented', { exact: false }).isVisible({ timeout: 3000 }).catch(() => false);
        const gotItButton = await page.getByRole('button', { name: 'Got it', exact: false }).isVisible({ timeout: 3000 }).catch(() => false);
        
        if (suspiciousLoginText || gotItButton) {
            logger.info('[😈 Daemon Login] Suspicious login prevented message detected!');
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-suspicious-login-message.png') });
            
            // Click the "Got it" button if visible
            const gotItElement = page.getByRole('button', { name: 'Got it', exact: false });
            if (await gotItElement.isVisible({ timeout: 3000 })) {
                logger.info('[😈 Daemon Login] "Got it" button found. Clicking...');
                await gotItElement.click();
                await page.waitForTimeout(3000);
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-after-got-it-click.png') });
            } else {
                logger.warn('[😈 Daemon Login] "Got it" button not visible despite suspicious login message.');
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-no-got-it-button.png') });
            }
        }

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
        logger.error('[😈 Daemon Login] Error during automated login attempt:', error);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-automated-login-error.png') }).catch(() => {});
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
 * Helper function to find Space URL on the current loaded page
 */
async function findSpaceUrlOnPage(page: Page): Promise<string | null> {
    try {
        // Look for Space links in tweet text
        const spaceUrlRegex = /https:\/\/(?:twitter|x)\.com\/i\/spaces\/([a-zA-Z0-9]+)/;
        
        // Get all text content from tweet elements
        const tweetTexts = await page.locator('div[data-testid="tweetText"]').allTextContents();
        
        // Check each tweet text for Space URL
        for (const text of tweetTexts) {
            const match = text.match(spaceUrlRegex);
            if (match) {
                logger.info(`[🔍 Thread] Found Space URL in tweet text: ${match[0]}`);
                return match[0];
            }
        }
        
        // Also check for any Space links in the page
        const spaceLinks = await page.locator('a[href*="/spaces/"]').all();
        for (const link of spaceLinks) {
            const href = await link.getAttribute('href');
            if (href) {
                const fullUrl = href.startsWith('http') ? href : `https://twitter.com${href}`;
                if (spaceUrlRegex.test(fullUrl)) {
                    logger.info(`[🔍 Thread] Found Space URL in link: ${fullUrl}`);
                    return fullUrl;
                }
            }
        }
        
        return null;
    } catch (error) {
        logger.error(`[🔍 Thread] Error searching for Space URL on page:`, error);
        return null;
    }
}

/**
 * Attempts to find a Space URL by navigating to the tweet and scrolling up.
 * @param page The Playwright page
 * @param tweetUrl The URL of the mention tweet
 * @returns The Space URL or null if not found
 */
async function findSpaceUrlInTweetThread(page: Page, tweetUrl: string): Promise<string | null> {
    logger.info(`[🔍 Thread] Navigating to tweet to look for Space URL: ${tweetUrl}`);
    
    try {
        // Navigate to the tweet
        await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        logger.info(`[🔍 Thread] Tweet page loaded. Looking for Space URL...`);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'tweet-thread-loaded.png') });
        
        // Let page settle
        await page.waitForTimeout(3000);
        
        // First check if Space URL is visible on the current page
        const spaceUrlOnPage = await findSpaceUrlOnPage(page);
        if (spaceUrlOnPage) {
            logger.info(`[🔍 Thread] Found Space URL on initial page load: ${spaceUrlOnPage}`);
            return spaceUrlOnPage;
        }
        
        // Scroll up to find parent tweets that might contain the Space URL
        logger.info(`[🔍 Thread] No Space URL found initially. Scrolling up to find parent tweets...`);
        
        // Maximum scroll attempts
        const MAX_SCROLL_UP = 10;
        
        for (let i = 0; i < MAX_SCROLL_UP; i++) {
            logger.info(`[🔍 Thread] Scroll up attempt ${i+1}/${MAX_SCROLL_UP}`);
            
            // Scroll up
            await page.evaluate(() => {
                window.scrollBy(0, -window.innerHeight);
            });
            await page.waitForTimeout(1000);
            
            // Take screenshot every few scrolls
            if (i % 2 === 0) {
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, `tweet-thread-scroll-${i}.png`) });
            }
            
            // Check if we're at the top of the page
            const atTop = await page.evaluate(() => {
                return window.scrollY === 0;
            });
            
            // Check for Space URL after scrolling
            const spaceUrl = await findSpaceUrlOnPage(page);
            if (spaceUrl) {
                logger.info(`[🔍 Thread] Found Space URL after scrolling up: ${spaceUrl}`);
                return spaceUrl;
            }
            
            // If we're at the top, no need to continue scrolling
            if (atTop) {
                logger.info(`[🔍 Thread] Reached top of page. No Space URL found.`);
                break;
            }
        }
        
        // No Space URL found after scrolling
        logger.warn(`[🔍 Thread] No Space URL found in the tweet thread after scrolling up.`);
        
        return null;
    } catch (error) {
        logger.error(`[🔍 Thread] Error finding Space URL in tweet thread:`, error);
        return null;
    }
}

/**
 * Extracts the tweet URL from a mention element
 * @param page The Playwright page
 * @param mention The mention element
 * @returns The full tweet URL or null if not found
 */
async function extractTweetUrl(page: Page, mention: Locator): Promise<string | null> {
    try {
        // Find the tweet's permalink element
        const timestampLink = mention.locator('a[href*="/status/"]').first();
        if (!await timestampLink.isVisible({ timeout: 2000 }).catch(() => false)) {
            logger.warn('[🧵 Extract] Could not find timestamp link in mention');
            return null;
        }
        
        // Get the href attribute
        const href = await timestampLink.getAttribute('href');
        if (!href) {
            logger.warn('[🧵 Extract] Timestamp link has no href attribute');
            return null;
        }
        
        // Convert to full URL if it's a relative URL
        const fullUrl = href.startsWith('http') ? href : `https://twitter.com${href}`;
        logger.debug(`[🧵 Extract] Extracted tweet URL: ${fullUrl}`);
        return fullUrl;
    } catch (error) {
        logger.error('[🧵 Extract] Error extracting tweet URL:', error);
        return null;
    }
}

/**
 * Extracts the username from a mention element
 * @param mention The mention element
 * @returns The username (without @) or null if not found
 */
async function extractUsername(mention: Locator): Promise<string | null> {
    try {
        // Find the username element, which is usually in a group with role="link"
        const usernameElement = mention.locator('div[data-testid="User-Name"] span').filter({ hasText: /@\w+/ }).first();
        
        if (!await usernameElement.isVisible({ timeout: 2000 }).catch(() => false)) {
            logger.warn('[🧵 Extract] Could not find username element in mention');
            return null;
        }
        
        // Get the text content and extract username
        const usernameText = await usernameElement.textContent();
        if (!usernameText) {
            logger.warn('[🧵 Extract] Username element has no text content');
            return null;
        }
        
        // Extract username without @ symbol
        const username = usernameText.trim().replace('@', '');
        logger.debug(`[🧵 Extract] Extracted username: ${username}`);
        return username;
    } catch (error) {
        logger.error('[🧵 Extract] Error extracting username:', error);
        return null;
    }
}

/**
 * Extracts the tweet ID from a tweet URL
 * @param tweetUrl The full tweet URL
 * @returns The tweet ID or null if not found
 */
async function extractTweetId(tweetUrl: string): Promise<string | null> {
    try {
        // Use regex to extract the tweet ID from URL
        const tweetIdRegex = /\/status\/(\d+)/;
        const match = tweetUrl.match(tweetIdRegex);
        
        if (!match || !match[1]) {
            logger.warn(`[🧵 Extract] Could not extract tweet ID from URL: ${tweetUrl}`);
            return null;
        }
        
        logger.debug(`[🧵 Extract] Extracted tweet ID: ${match[1]}`);
        return match[1];
    } catch (error) {
        logger.error('[🧵 Extract] Error extracting tweet ID:', error);
        return null;
    }
}

/**
 * Processes a single mention.
 * @param page The Playwright page.
 * @param mention The mention element to process.
 * @param mentionIndex The index of the mention for logging.
 * @returns True if the mention was processed successfully, false otherwise.
 */
async function processMention(
    page: Page,
    mention: Locator,
    mentionIndex: number
): Promise<boolean> {
    logger.info(`[🧵 Mention] Processing mention ${mentionIndex}...`);
    
    try {
        // Extract tweet URL and username early for potential replies
        const tweetUrl = await extractTweetUrl(page, mention);
        if (!tweetUrl) {
            logger.warn(`[🧵 Mention] Could not extract tweet URL for mention ${mentionIndex}.`);
            return false;
        }
        logger.info(`[🧵 Mention] Found tweet URL: ${tweetUrl}`);

        const username = await extractUsername(mention);
        if (!username) {
            logger.warn(`[🧵 Mention] Could not extract username for mention ${mentionIndex}.`);
            return false;
        }
        logger.info(`[🧵 Mention] Found username: ${username}`);

        // Extract text from the mention
        const mentionText = await mention.locator('div[data-testid="tweetText"]').textContent();
        if (!mentionText) {
            logger.warn(`[🧵 Mention] Could not extract text from mention ${mentionIndex}.`);
            return false;
        }
        logger.info(`[🧵 Mention] Found mention text: ${mentionText}`);
        
        // First try to extract Space URL from mention text
        let spaceUrl = extractSpaceUrl(mentionText);
        
        // If no Space URL in mention text, try to find it in the tweet thread
    if (!spaceUrl) {
            logger.info(`[🧵 Mention] No Space URL found in mention text. Will check the tweet thread for ${tweetUrl}.`);
            spaceUrl = await findSpaceUrlInTweetThread(page, tweetUrl);
            // Add clear logging after checking the thread
            if (spaceUrl) {
                logger.info(`[🧵 Mention] Found Space URL in thread after check: ${spaceUrl}`);
            } else {
                logger.warn(`[🧵 Mention] Still no Space URL found after checking thread for tweet ${tweetUrl}.`);
            }
        }
        
        if (!spaceUrl) {
            logger.warn(`[🧵 Mention] No Space URL found in mention ${mentionIndex} or its thread. Skipping processing for this mention.`);
            // Post a reply indicating no Space was found in this specific mention
            await postReplyToTweet(page, tweetUrl, 
                `@${username} Sorry, I couldn't find a Twitter Space link in this specific tweet or its recent thread.` // Use extracted username
            );
            return false; // Indicate failure to find URL for this mention
        }
        
        logger.info(`[🧵 Mention] Found Space URL: ${spaceUrl} associated with mention tweet ${tweetUrl}`);
        
        // Add mention to the queue for processing
        const tweetId = (await extractTweetId(tweetUrl)) || `unknown_${Date.now()}`; // Provide a fallback ID
        const mentionInfo: MentionInfo = {
            tweetId,
            tweetUrl,
            username, // Already extracted
            text: mentionText
        };
        
        mentionQueue.push(mentionInfo);
        logger.info(`[⚙️ Queue] Mention ${mentionInfo.tweetId} added. Queue size: ${mentionQueue.length}`);
        
        // Trigger the queue worker if it's not already running
        if (!isProcessingQueue) {
            runProcessingQueue(page).catch(err => {
                logger.error('[🧵 Mention] Unhandled error in queue worker execution:', err);
                isProcessingQueue = false; // Ensure flag is reset on error
            });
        }
        
        return true;
    } catch (error) {
        logger.error(`[🧵 Mention] Error processing mention ${mentionIndex}:`, error);
        return false;
    }
}

/**
 * Processes a mention request from the queue.
 * @param mentionInfo Information about the mention to process
 * @param page The Playwright page
 */
async function processMentionRequest(mentionInfo: MentionInfo, page: Page): Promise<void> {
    logger.info(`[🎬 Processing] Starting to process mention from ${mentionInfo.username} (tweet ID: ${mentionInfo.tweetId})`);
    
    try {
        // Extract space URL from mention text
        let spaceUrl = extractSpaceUrl(mentionInfo.text);
        
        if (!spaceUrl) {
            logger.info(`[🎬 Processing] No Space URL found in mention text. Checking original tweet thread...`);
            
            // Navigate to the tweet to check the thread
            logger.info(`[🎬 Processing] Navigating to tweet: ${mentionInfo.tweetUrl}`);
            await page.goto(mentionInfo.tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);
            
            // Take a screenshot for debugging
            const screenshotsDir = path.join(process.cwd(), 'debug-screenshots');
            await page.screenshot({ path: path.join(screenshotsDir, `mention-thread-${mentionInfo.tweetId}.png`) });
            
            // Check if we're looking at a reply thread, and if so look for Space URL in the conversation
            // First check the original tweet in the thread
            logger.info(`[🎬 Processing] Checking for Space URL in the tweet thread...`);
            
            // Look for all tweets in the thread, including parent tweets
            const tweets = await page.locator('article[data-testid="tweet"]').all();
            logger.info(`[🎬 Processing] Found ${tweets.length} tweets in the thread`);
            
            // Check each tweet for a Space URL, starting from the oldest (top) tweets
            for (const tweet of tweets) {
                // Extract tweet text
                const tweetTextElement = await tweet.locator('div[data-testid="tweetText"]').first();
                if (!tweetTextElement) continue;
                
                const tweetText = await tweetTextElement.innerText().catch(() => "");
                logger.info(`[🎬 Processing] Checking tweet text: "${tweetText.substring(0, 50)}..."`);
                
                // Check for Space URL in this tweet
                const foundSpaceUrl = extractSpaceUrl(tweetText);
                if (foundSpaceUrl) {
                    logger.info(`[🎬 Processing] Found Space URL in thread: ${foundSpaceUrl}`);
                    spaceUrl = foundSpaceUrl;
                    break;
                }
                
                // Also check for Space cards in the tweet
                const spaceCards = await tweet.locator('div[data-testid="card.wrapper"] a[href*="/spaces/"]').all();
                if (spaceCards.length > 0) {
                    for (const card of spaceCards) {
                        const href = await card.getAttribute('href');
                        if (href && href.includes('/spaces/')) {
                            logger.info(`[🎬 Processing] Found Space card in thread: ${href}`);
                            spaceUrl = href;
                            break;
                        }
                    }
                }
                
                if (spaceUrl) break; // Exit the loop if we found a Space URL
            }
        }
        
        if (!spaceUrl) {
            logger.warn(`[🎬 Processing] No Space URL found in mention or thread. Replying with error message.`);
            await postReplyToTweet(page, mentionInfo.tweetUrl, 
                `@${mentionInfo.username} I'm sorry but there is no X space in this tweet. Please tag me in a tweet that contains a Space URL.`);
        return;
    }

        logger.info(`[🎬 Processing] Found Space URL: ${spaceUrl}`);
        
        // Extract space ID from URL
    const spaceId = extractSpaceId(spaceUrl);
    if (!spaceId) {
            logger.warn(`[🎬 Processing] Could not extract Space ID from URL: ${spaceUrl}`);
            await postReplyToTweet(page, mentionInfo.tweetUrl, 
                `@${mentionInfo.username} I couldn't identify a valid Space ID in that URL. Please make sure you're sharing a valid X Space.`);
        return;
    }
        logger.info(`[🎬 Processing] Space ID: ${spaceId}`);
        
        // Navigate to the space page to get the m3u8 URL
        logger.info(`[🎬 Processing] Navigating to Space page to get audio stream...`);
        const m3u8Result = await getM3u8ForSpacePage(spaceUrl, page);
        
        if (!m3u8Result || !m3u8Result.m3u8Url) {
            logger.warn(`[🎬 Processing] Could not get m3u8 URL from Space page.`);
            await postReplyToTweet(page, mentionInfo.tweetUrl, 
                `Sorry @${mentionInfo.username}, I couldn't access that Space's audio stream. It might be ended or private.`);
            return;
        }
        logger.info(`[🎬 Processing] Got m3u8 URL for stream`);
        
        // Download audio from the m3u8 URL and upload to S3
        logger.info(`[🎬 Processing] Downloading and uploading Space audio...`);
        const audioUploadResult = await downloadAndUploadAudio(m3u8Result.m3u8Url, spaceId);
        
        if (!audioUploadResult) {
            logger.warn(`[🎬 Processing] Failed to download/upload Space audio.`);
            await postReplyToTweet(page, mentionInfo.tweetUrl, 
                `Sorry @${mentionInfo.username}, I couldn't download the Space's audio. It might be corrupted or unavailable.`);
            return;
        }
        logger.info(`[🎬 Processing] Audio uploaded to S3: ${audioUploadResult}`);
        
        // Create a dubbing project in SpeechLab
        logger.info(`[🎬 Processing] Creating SpeechLab dubbing project...`);
        const projectCreationResult = await createDubbingProject(audioUploadResult, spaceId);
        
        if (!projectCreationResult) {
            logger.warn(`[🎬 Processing] Failed to create SpeechLab project.`);
            await postReplyToTweet(page, mentionInfo.tweetUrl, 
                `Sorry @${mentionInfo.username}, I couldn't create a translation project for this Space. Please try again later.`);
            return;
        }
        logger.info(`[🎬 Processing] SpeechLab project created: ${projectCreationResult}`);
        
        // Wait for project processing to complete
        logger.info(`[🎬 Processing] Waiting for SpeechLab project to complete...`);
        const projectCompleted = await waitForProjectCompletion(projectCreationResult);
        
        if (!projectCompleted) {
            logger.warn(`[🎬 Processing] SpeechLab project failed to complete.`);
            await postReplyToTweet(page, mentionInfo.tweetUrl, 
                `Sorry @${mentionInfo.username}, the translation project for this Space failed to process. Please try again later.`);
            return;
        }
        logger.info(`[🎬 Processing] SpeechLab project completed successfully`);
        
        // Generate sharing link
        logger.info(`[🎬 Processing] Generating sharing link...`);
        const sharingLink = await generateSharingLink(projectCreationResult);
        
        if (!sharingLink) {
            logger.warn(`[🎬 Processing] Failed to generate sharing link.`);
            await postReplyToTweet(page, mentionInfo.tweetUrl, 
                `Sorry @${mentionInfo.username}, I couldn't generate a link to the translated Space. Please try again later.`);
            return;
        }
        logger.info(`[🎬 Processing] Sharing link generated: ${sharingLink}`);
        
        // Post reply with the sharing link
        logger.info(`[🎬 Processing] Posting reply with sharing link...`);
        // Since we don't have access to audioUploadResult.durationMs anymore, we'll estimate 10 minutes as a fallback
        // This is a simplification and might need to be addressed in a more robust way
        const minutesDuration = 10; // Default to 10 minutes if unknown
        await postReplyToTweet(page, mentionInfo.tweetUrl, 
            `@${mentionInfo.username} I've translated this ${minutesDuration}-minute Space to English! Listen here: ${sharingLink}`);
        
        logger.info(`[🎬 Processing] Successfully completed processing for tweet ${mentionInfo.tweetId}`);
    } catch (error) {
        logger.error(`[🎬 Processing] Error processing mention:`, error);
        try {
            // Try to post an error reply
            await postReplyToTweet(page, mentionInfo.tweetUrl, 
                `Sorry @${mentionInfo.username}, I encountered an error processing this Space. Please try again later.`);
        } catch (replyError) {
            logger.error(`[🎬 Processing] Failed to post error reply:`, replyError);
        }
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
        const browserInfo = await initializeDaemonBrowser(); // Use the imported function
        browser = browserInfo.browser;
        context = browserInfo.context;
        
        if (!context) { // Add null check for context
             throw new Error('Browser context could not be initialized in main daemon loop.');
        }
        
        page = await context.newPage();

        // Print more diagnostic info before login
        logger.info('[😈 Daemon] Browser and context initialized successfully.');
        logger.info(`[😈 Daemon] Twitter credentials - Username: ${config.TWITTER_USERNAME ? '✓ Set' : '❌ Missing'}, Password: ${config.TWITTER_PASSWORD ? '✓ Set' : '❌ Missing'}`);

        // Check if we're already logged in from saved state
        logger.info('[😈 Daemon] Checking if already logged in from saved state...');
        try {
            // Use a shorter timeout and domcontentloaded instead of networkidle
            await page.goto('https://twitter.com/home', { waitUntil: 'domcontentloaded', timeout: 15000 });
            logger.info('[😈 Daemon] Successfully navigated to Twitter home page.');
        } catch (navError) {
            logger.warn('[😈 Daemon] Timeout or error navigating to Twitter home. Will try to check login status anyway.');
            // Try to navigate to a different Twitter URL as fallback
            try {
                await page.goto('https://twitter.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
                logger.info('[😈 Daemon] Successfully navigated to Twitter main page as fallback.');
            } catch (fallbackNavError) {
                logger.warn('[😈 Daemon] Also failed to navigate to Twitter main page. Will still try to check login status.');
            }
        }
        
        // Check for login success indicators
        const successIndicators = [
            '[data-testid="AppTabBar_Home_Link"]', 
            'a[href="/home"]',
            '[data-testid="SideNav_NewTweet_Button"]',
            '[data-testid="primaryColumn"]'
        ];
        
        let isLoggedIn = false;
        for (const selector of successIndicators) {
            if (await page.locator(selector).first().isVisible({ timeout: 3000 }).catch(() => false)) {
                logger.info(`[😈 Daemon] ✅ Already logged in from saved state! (indicator: ${selector})`);
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-already-logged-in.png') });
                isLoggedIn = true;
                break;
            }
        }
        
        // Only attempt login if not already logged in
        if (!isLoggedIn) {
            logger.info('[😈 Daemon] Not logged in from saved state. Attempting login process...');
            
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
        }
        
        logger.info('[😈 Daemon] Twitter login confirmed. Ready to monitor mentions.');

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
                            logger.info(`[🔔 Mention]   No Twitter Space URL found in mention text. Adding to queue to check thread and potentially reply.`);
                            // Instead of immediately marking as processed, add to queue to check thread
                            mentionQueue.push(mention);
                            logger.info(`[⚙️ Queue] Mention ${mention.tweetId} without Space URL added to queue for thread checking. Queue size: ${mentionQueue.length}`);
                            
                            // Trigger the queue worker if it's not already running
                            if (page && !page.isClosed() && !isProcessingQueue) {
                                runProcessingQueue(page).catch(err => {
                                    logger.error('[😈 Daemon] Unhandled error in queue worker execution:', err);
                                    isProcessingQueue = false; // Ensure flag is reset on error
                                }); 
                            } else if (!page || page.isClosed()) {
                                logger.error('[😈 Daemon] Page is closed, cannot start queue worker.');
                            }
                            
                            // Mark as processed after adding to queue
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
                        // Use domcontentloaded instead of networkidle and shorter timeout
                        await page.goto('https://twitter.com/home', { waitUntil: 'domcontentloaded', timeout: 15000 });
                         logger.info('[😈 Daemon] Recovered page state by navigating home.');
                     } catch (recoveryError) {
                        logger.warn('[😈 Daemon] Failed first recovery attempt. Trying alternative approach...');
                        try {
                            // Try a different URL with even shorter timeout
                            await page.goto('https://twitter.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
                            logger.info('[😈 Daemon] Recovered page state by navigating to Twitter main page.');
                        } catch (altRecoveryError) {
                            logger.error('[😈 Daemon] Failed all recovery attempts:', altRecoveryError);
                         if (intervalId) clearInterval(intervalId); 
                         intervalId = null;
                         throw new Error('Failed to recover polling page'); // Let main catch handle shutdown
                        }
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