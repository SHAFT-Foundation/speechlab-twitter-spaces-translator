import { config } from './utils/config';
import logger from './utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import { chromium, Browser, Page, BrowserContext, Locator } from 'playwright';
import { 
    scrapeMentions, 
    MentionInfo, 
    postReplyToTweet,
    initializeDaemonBrowser,
    extractSpaceUrl, 
    extractSpaceId,
    findSpaceUrlOnPage,
    clickPlayButtonAndCaptureM3u8,
    extractSpaceTitleFromModal
} from './services/twitterInteractionService';
import { downloadAndUploadAudio } from './services/audioService';
import { createDubbingProject, waitForProjectCompletion, generateSharingLink } from './services/speechlabApiService';
import { detectLanguage, getLanguageName } from './utils/languageUtils';
import { v4 as uuidv4 } from 'uuid';
import { downloadFile } from './utils/fileUtils';
import { exec } from 'child_process';
import util from 'util';
import { postTweetReplyWithMediaApi } from './services/twitterApiService';
import { uploadLocalFileToS3 } from './services/audioService';

const execPromise = util.promisify(exec);

// --- Queues & Workers Data Structures ---
const mentionQueue: MentionInfo[] = []; // Queue for incoming mentions
const finalReplyQueue: { mentionInfo: MentionInfo, backendResult: BackendResult }[] = []; // Queue for final replies
let isInitiatingProcessing = false; // Flag for browser task (initiation)
let isPostingFinalReply = false;   // Flag for browser task (final reply)

// --- MOVED: Global Set for Processed Mentions ---
let processedMentions: Set<string> = new Set();
// --- END MOVED SECTION ---

// Interface for data passed from initiation to backend
interface InitiationResult {
    m3u8Url: string;
    spaceId: string;
    spaceTitle: string | null;
    mentionInfo: MentionInfo; // Pass original mention info
    targetLanguageCode: string;
    targetLanguageName: string;
}
// Interface for backend result
interface BackendResult {
    success: boolean;
    sharingLink?: string;   // Link to SpeechLab project page
    publicMp3Url?: string;  // Link to the uploaded dubbed MP3 on S3
    projectId?: string;
    error?: string;
    // Path to the FINAL generated video file
    // generatedVideoPath?: string; 
}

const PROCESSED_MENTIONS_PATH = path.join(process.cwd(), 'processed_mentions.json');
const POLLING_INTERVAL_MS = 10 * 60 * 1000; // Check every 10 minutes (10 * 60 * 1000 ms)
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
 * Helper to find the article OR the direct button for playing a Space recording.
 * Prioritizes finding within an article, then falls back to searching the whole page.
 * @returns A Locator for either the containing article OR the button itself, or null.
 */
async function findArticleWithPlayButton(page: Page): Promise<Locator | null> {
    logger.debug('[🐦 Helper] Searching for playable Space element (button or article)...');
    
    // Use case-insensitive regex for text matching
    const playButtonTextRegex = /Play recording/i; 
    const playButtonNameRegex = /Play recording/i; // Case-insensitive regex for getByRole
    const articleSelector = 'article[data-testid="tweet"]';
    const flexibleButtonXPath = "//button[contains(@aria-label, 'Play recording') or .//span[contains(text(), 'Play recording')]]";

    const VISIBILITY_TIMEOUT_SHORT = 1000; // Increased slightly
    const VISIBILITY_TIMEOUT_LONG = 2000; // Increased slightly

    // --- Strategy 1: Find TEXT (regex) within articles --- 
    logger.debug(`[🐦 Helper] Strategy 1: Searching within articles (${articleSelector}) using getByText(${playButtonTextRegex})...`);
    const articles = await page.locator(articleSelector).all();
    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        if (!await article.isVisible().catch(() => false)) {
             logger.debug(`[🐦 Helper] Article ${i + 1} is not visible, skipping.`);
             continue;
         }
        // Find element with the text regex within the article
        const textElementInArticle = article.getByText(playButtonTextRegex);
        if (await textElementInArticle.isVisible({ timeout: VISIBILITY_TIMEOUT_SHORT })) {
            logger.info(`[🐦 Helper] Found text matching ${playButtonTextRegex} in article ${i + 1}. Returning article locator.`);
             // Check if the found element *is* the button, otherwise return the article
            const tagName = await textElementInArticle.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
            if (tagName === 'button') {
                 logger.info(`[🐦 Helper] The text element itself is the button. Returning button.`);
                return textElementInArticle;
            }
            // Try finding the button *near* the text within the article
            const buttonNearText = article.locator('button').filter({ has: textElementInArticle }).first();
            if (await buttonNearText.isVisible({timeout: 500})){
                logger.info(`[🐦 Helper] Found button near text in article ${i+1}. Returning button.`);
                return buttonNearText;
            }
            logger.info(`[🐦 Helper] Text found, but couldn't pinpoint button within. Returning containing article.`);
            return article; 
        }
    }

    // --- Strategy 2: Find TEXT (regex) page-wide --- 
    logger.info(`[🐦 Helper] Strategy 2: Searching page-level using getByText(${playButtonTextRegex})...`);
    const textElementOnPage = page.getByText(playButtonTextRegex).first(); 
    if (await textElementOnPage.isVisible({ timeout: VISIBILITY_TIMEOUT_LONG })) {
        logger.info(`[🐦 Helper] Found text matching ${playButtonTextRegex} directly on page.`);
        // Attempt to find the closest button ancestor or return the element if it's a button
        try {
            const buttonAncestor = textElementOnPage.locator('xpath=ancestor-or-self::button').first();
            if (await buttonAncestor.isVisible({timeout: VISIBILITY_TIMEOUT_SHORT})) {
                logger.info('[🐦 Helper] Found closest button ancestor/self for the text. Returning button locator.');
                return buttonAncestor;
            } else {
                logger.warn('[🐦 Helper] Found text, but no button ancestor. Returning text element directly.');
                return textElementOnPage; // Fallback
            }
        } catch (e) {
             logger.warn('[🐦 Helper] Error finding button ancestor for text, returning text element directly.');
             return textElementOnPage; // Fallback
        }
    }

    // --- Strategy 3: Find button within articles using getByRole --- 
    logger.debug(`[🐦 Helper] Strategy 3: Searching within articles (${articleSelector}) using getByRole...`);
    // Reuse articles from Strategy 1
    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        if (!await article.isVisible().catch(() => false)) continue; // Skip non-visible articles
        const buttonInArticle = article.getByRole('button', { name: playButtonNameRegex }).first();
        if (await buttonInArticle.isVisible({ timeout: VISIBILITY_TIMEOUT_SHORT })) {
            logger.info(`[🐦 Helper] Found Play button in article ${i + 1} using getByRole. Returning article.`);
            return article; // Return the article containing the button
        }
    }

    // --- Strategy 4: Find button directly on page using getByRole --- 
    logger.info('[🐦 Helper] Strategy 4: Searching page-level using getByRole...');
    const buttonByRole = page.getByRole('button', { name: playButtonNameRegex }).first();
    if (await buttonByRole.isVisible({ timeout: VISIBILITY_TIMEOUT_LONG })) {
        logger.info('[🐦 Helper] Found Play button using getByRole directly on page. Returning button locator.');
        return buttonByRole;
    }
    
    // --- Strategy 5: Find button directly on page using flexible XPath --- 
    logger.info('[🐦 Helper] Strategy 5: Searching page-level using flexible XPath...');
    const buttonByXPath = page.locator(flexibleButtonXPath).first();
    if (await buttonByXPath.isVisible({ timeout: VISIBILITY_TIMEOUT_LONG })) {
        logger.info('[🐦 Helper] Found Play button using flexible XPath directly on page. Returning button locator.');
        return buttonByXPath;
    }

    logger.warn('[🐦 Helper] Could not find any playable element using text, getByRole, or XPath strategies.');
    // Log full page HTML for debugging if everything fails
    try {
        const html = await page.content();
        const logPath = path.join(process.cwd(), 'logs', 'find-button-fail.html');
        await fs.writeFile(logPath, html);
        logger.warn(`[🐦 Helper] Saved full page HTML to ${logPath} for debugging.`);
    } catch (htmlError) {
        logger.error('[🐦 Helper] Failed to save page HTML on find failure:', htmlError);
    }
    return null;
}

// --- NEW FUNCTION: Browser-dependent initiation steps --- 
/**
 * Handles the initial browser interaction for a mention:
 * - Navigates to the mention tweet.
 * - Finds the playable Space article.
 * - Clicks Play and captures the M3U8 URL.
 * - Posts an acknowledgement reply.
 * @returns Data needed for backend processing.
 * @throws Error if initiation fails (error reply should be attempted internally).
 */
async function initiateProcessing(mentionInfo: MentionInfo, page: Page): Promise<InitiationResult> {
    logger.info(`[🚀 Initiate] Starting browser phase for ${mentionInfo.tweetId}`);
    // Rename variable to reflect it might be article OR button
    let playElementLocator: Locator | null = null;

    // Detect target language early
    const targetLanguageCode = detectLanguage(mentionInfo.text);
    const targetLanguageName = getLanguageName(targetLanguageCode);
    logger.info(`[🚀 Initiate] Target language: ${targetLanguageName} (${targetLanguageCode})`);

    // 1. Navigate & Find Article
    try {
        logger.info(`[🚀 Initiate] Navigating to mention tweet: ${mentionInfo.tweetUrl}`);
        await page.goto(mentionInfo.tweetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        logger.info('[🚀 Initiate] Waiting 60 seconds after navigation...');
        await page.waitForTimeout(60000);

        // --- ADDED: Screenshot before searching ---
        logger.info('[🚀 Initiate] Taking screenshot before attempting to find play button/article...');
        const screenshotDir = path.join(process.cwd(), 'debug-screenshots'); 
        await page.screenshot({ path: path.join(screenshotDir, `before-find-play-button-${mentionInfo.tweetId}.png`) });
        // --- END ADDED SECTION ---

        playElementLocator = await findArticleWithPlayButton(page); // Function now finds article or button
        if (!playElementLocator) {
            logger.info('[🚀 Initiate] Play button/article not immediately visible. Scrolling up...');
            const MAX_SCROLL_UP = 5;
            for (let i = 0; i < MAX_SCROLL_UP && !playElementLocator; i++) {
                await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
                logger.info(`[🚀 Initiate] Waiting 60 seconds after scroll attempt ${i+1}...`);
                await page.waitForTimeout(60000);
                playElementLocator = await findArticleWithPlayButton(page);
            }
        }

        if (!playElementLocator) {
            const errMsg = `Could not find playable Space element (article or button) for tweet ${mentionInfo.tweetId}.`; // Updated error message
            logger.warn(`[🚀 Initiate] ${errMsg}`);
            await postReplyToTweet(page, mentionInfo.tweetUrl,
                `@${mentionInfo.username} Sorry, I couldn't find a playable Twitter Space associated with this tweet.`);
            throw new Error(errMsg); // Throw to signal failure
        }
        logger.info(`[🚀 Initiate] Found potential Space element (article or button).`);

    } catch (error) {
        logger.error(`[🚀 Initiate] Error during navigation/article finding for ${mentionInfo.tweetId}:`, error);
        // Try to post error reply if possible (and if it wasn't the error above)
        if (!(error instanceof Error && error.message.includes('Playable Space article not found'))) {
            try {
                 await postReplyToTweet(page, mentionInfo.tweetUrl,
                    `@${mentionInfo.username} Sorry, I had trouble loading the tweet to find the Space.`);
            } catch (replyError) { /* Ignore */ }
        }
        throw error; // Re-throw original error
    }
    
    // 2. Extract Title from Article (First attempt, before clicking Play)
    let spaceTitle: string | null = null;
    try {
        logger.debug(`[🚀 Initiate] Attempting to extract Space title from located element...`);
        // Try common selectors for Space titles within cards/articles
        const titleSelectors = [
            // Specific testids if available
            'div[data-testid="card.layoutLarge.title"] span', 
            'div[data-testid*="AudioSpaceCardHeader"] span[aria-hidden="true"]', // Sometimes title is here
            // More generic: A prominent span near the play button (might need refinement)
            'div > span[dir="auto"]:not([aria-hidden="true"])', // Look for direct child span
            'span[data-testid="card.layoutSmall.media.title"]' // Added for small card layout
        ];
        
        for (const selector of titleSelectors) {
            logger.debug(`[🚀 Initiate] Trying title selector: ${selector}`);
            // Use the found locator (could be article or button)
            const titleElement = playElementLocator.locator(selector).first(); 
            if (await titleElement.isVisible({ timeout: 500 })) {
                const potentialTitle = await titleElement.textContent({ timeout: 1000 });
                 if (potentialTitle && potentialTitle.trim().length > 0) {
                    spaceTitle = potentialTitle.trim().substring(0, 100); // Limit length
                    logger.info(`[🚀 Initiate] Extracted potential Space title from located element using selector ${selector}: "${spaceTitle}"`);
                    break; // Stop trying selectors once found
                } else {
                    logger.debug(`[🚀 Initiate] Selector ${selector} found element but text was empty.`);
                }
            } else {
                 logger.debug(`[🚀 Initiate] Selector ${selector} did not find visible element.`);
            }
        }

        if (!spaceTitle) {
             logger.warn('[🚀 Initiate] Could not extract Space title from located element using known selectors.');
        }

    } catch (titleError) {
        logger.warn('[🚀 Initiate] Error during Space title extraction from located element:', titleError);
    }

    // 3. Click Play and capture M3U8
    let m3u8Url: string | null = null;
    try {
        logger.info(`[🚀 Initiate] Clicking Play button and capturing M3U8...`);
        // Pass the located element (article or button) to the capture function
        m3u8Url = await clickPlayButtonAndCaptureM3u8(page, playElementLocator); 
        if (!m3u8Url) {
             const errMsg = `Failed to capture M3U8 URL for tweet ${mentionInfo.tweetId}.`;
             logger.error(`[🚀 Initiate] ${errMsg}`);
            await postReplyToTweet(page, mentionInfo.tweetUrl,
                `@${mentionInfo.username} Sorry, I could find the Space but couldn't get its audio stream. It might be finished or protected.`);
             throw new Error(errMsg);
        }
        logger.info(`[🚀 Initiate] Captured M3U8 URL.`);
        
        // 4. Now try to extract title from modal
        try {
            logger.info('[🚀 Initiate] Waiting 60 seconds before extracting modal title...');
            await page.waitForTimeout(60000);
            logger.info('[🚀 Initiate] Attempting to extract Space title from modal after clicking Play...');
            const modalTitle = await extractSpaceTitleFromModal(page);
            if (modalTitle) {
                logger.info(`[🚀 Initiate] Successfully extracted Space title from modal: "${modalTitle}"`);
                // Modal title takes precedence
                spaceTitle = modalTitle;
            } else {
                logger.warn('[🚀 Initiate] Could not extract Space title from modal, will use article title if available.');
            }
        } catch (modalTitleError) {
            logger.warn('[🚀 Initiate] Error extracting Space title from modal:', modalTitleError);
            // Continue with article title if modal extraction fails
        }
    } catch (error) {
         logger.error(`[🚀 Initiate] Error during M3U8 capture for ${mentionInfo.tweetId}:`, error);
         try {
             await postReplyToTweet(page, mentionInfo.tweetUrl,
                `@${mentionInfo.username} Sorry, I encountered an error trying to access the Space audio.`);
         } catch(replyError) { /* Ignore */ }
         throw error;
    }

    // 5. Extract Space ID (Best Effort)
    const spaceId = m3u8Url.match(/([a-zA-Z0-9_-]+)\/(?:chunk|playlist)/)?.[1] || `space_${mentionInfo.tweetId || uuidv4()}`;
    logger.info(`[🚀 Initiate] Using Space ID: ${spaceId}`);
    
    // Log final title status
    if (spaceTitle) {
        logger.info(`[🚀 Initiate] Final Space title for processing: "${spaceTitle}"`);
    } else {
        logger.warn(`[🚀 Initiate] No Space title could be extracted, will use generic name in processing.`);
    }

    // 6. Post preliminary acknowledgement reply
    try {
        logger.info(`[🚀 Initiate] Posting preliminary acknowledgement reply...`);
        const ackMessage = `@${mentionInfo.username} Received! I've started processing this Space into ${targetLanguageName}. Please check back here in ~10-15 minutes for the translated link.`;
        const ackSuccess = await postReplyToTweet(page, mentionInfo.tweetUrl, ackMessage);
        if (!ackSuccess) {
            logger.warn(`[🚀 Initiate] Failed to post acknowledgement reply (non-critical).`);
        }
    } catch (ackError) {
        logger.warn(`[🚀 Initiate] Error posting acknowledgement reply (non-critical):`, ackError);
    }

    logger.info(`[🚀 Initiate] Browser phase complete for ${mentionInfo.tweetId}. Returning data.`);
    return {
        m3u8Url,
        spaceId,
        spaceTitle,
        mentionInfo, // Include original mention info
        targetLanguageCode,
        targetLanguageName,
    };
}

// --- NEW FUNCTION: Backend Processing Function (No Browser) --- 
/**
 * Handles backend processing: download, upload, SpeechLab tasks, and video download.
 * Does NOT interact with the browser page.
 */
async function performBackendProcessing(initData: InitiationResult): Promise<BackendResult> {
    const { m3u8Url, spaceId, spaceTitle, targetLanguageCode, mentionInfo } = initData;
    const TEMP_AUDIO_DIR = path.join(process.cwd(), 'temp_audio'); 
    // Remove video dir if not generating video
    // const TEMP_VIDEO_DIR = path.join(process.cwd(), 'temp_video'); 
    // const PLACEHOLDER_IMAGE_PATH = path.join(process.cwd(), 'placeholder.jpg');

    logger.info(`[⚙️ Backend] Starting backend processing for Space ID: ${spaceId}, Lang: ${targetLanguageCode}`);

    let downloadedAudioPath: string | undefined = undefined;
    // let generatedVideoPath: string | undefined = undefined;
    let publicMp3Url: string | undefined = undefined;

    try {
        await fs.mkdir(TEMP_AUDIO_DIR, { recursive: true });
        // await fs.mkdir(TEMP_VIDEO_DIR, { recursive: true }); // No video dir needed now

        // 1. Download original Space audio and upload to S3 (for project creation)
        logger.info(`[⚙️ Backend] Downloading/uploading original Space audio for ${spaceId}...`);
        const audioUploadResult = await downloadAndUploadAudio(m3u8Url, spaceId);
        if (!audioUploadResult) {
            throw new Error('Failed to download/upload original Space audio');
        }
        logger.info(`[⚙️ Backend] Original audio uploaded to S3: ${audioUploadResult}`);

        // 2. Create SpeechLab project
        const projectName = spaceTitle || `Twitter Space ${spaceId}`; 
        const sanitizedProjectName = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        const thirdPartyID = `${sanitizedProjectName}-${targetLanguageCode}`;
        logger.info(`[⚙️ Backend] Creating SpeechLab project: Name="${projectName}", Lang=${targetLanguageCode}, 3rdPartyID=${thirdPartyID}`);
        const projectId = await createDubbingProject(
            audioUploadResult, 
            projectName, 
            targetLanguageCode, 
            thirdPartyID
        );
        if (!projectId) {
            throw new Error('Failed to create SpeechLab project');
        }
        logger.info(`[⚙️ Backend] SpeechLab project created: ${projectId} (using thirdPartyID: ${thirdPartyID})`);

        // 3. Wait for project completion (with increased timeout)
        logger.info(`[⚙️ Backend] Waiting up to 3 hours for SpeechLab project completion (thirdPartyID: ${thirdPartyID})...`);
        const maxWaitTimeMs = 3 * 60 * 60 * 1000; // 3 hours in milliseconds
        const completedProject = await waitForProjectCompletion(thirdPartyID, maxWaitTimeMs); 
        if (!completedProject || completedProject.job?.status !== 'COMPLETE') {
            const finalStatus = completedProject?.job?.status || 'TIMEOUT';
            throw new Error(`SpeechLab project ${thirdPartyID} did not complete successfully (Status: ${finalStatus})`);
        }
        logger.info(`[⚙️ Backend] SpeechLab project ${thirdPartyID} completed successfully.`);

        // 4. Find and Download DUBBED MP3 Audio
        const outputAudio = completedProject.translations?.[0]?.dub?.[0]?.medias?.find(d => 
            d.category === 'audio' && d.format === 'mp3' && d.operationType === 'OUTPUT'
        );

        if (outputAudio?.presignedURL) {
            logger.info(`[⚙️ Backend] Found DUBBED MP3 URL: ${outputAudio.presignedURL}`);
            const audioFilename = `${thirdPartyID}_dubbed.mp3`; 
            const destinationAudioPath = path.join(TEMP_AUDIO_DIR, audioFilename);
            downloadedAudioPath = destinationAudioPath; // Store path for cleanup
            
            logger.info(`[⚙️ Backend] Attempting to download dubbed audio to ${destinationAudioPath}...`);
            const downloadSuccess = await downloadFile(outputAudio.presignedURL, destinationAudioPath);
            
            if (!downloadSuccess) {
                 logger.warn(`[⚙️ Backend] Failed to download DUBBED audio file.`);
                 downloadedAudioPath = undefined; 
            } else {
                logger.info(`[⚙️ Backend] Successfully downloaded DUBBED audio: ${downloadedAudioPath}`);
                
                // 5. Upload the DUBBED MP3 to the PUBLIC S3 Bucket
                const publicS3Key = `dubbed-spaces/${audioFilename}`; // Example S3 path
                logger.info(`[⚙️ Backend] Uploading downloaded MP3 to public S3 bucket as ${publicS3Key}...`);
                const uploadedUrl = await uploadLocalFileToS3(downloadedAudioPath, publicS3Key);
                if (uploadedUrl) {
                    publicMp3Url = uploadedUrl;
                    logger.info(`[⚙️ Backend] ✅ Successfully uploaded dubbed MP3 to public S3: ${publicMp3Url}`);
                } else {
                    logger.error(`[⚙️ Backend] ❌ Failed to upload dubbed MP3 to public S3.`);
                    // Continue without the public URL, but keep downloaded file for cleanup
                }
                // Skip video conversion logic
            }
        } else {
            logger.warn(`[⚙️ Backend] Could not find DUBBED MP3 audio output URL in project details.`);
        }

        // 6. Generate sharing link 
        logger.info(`[⚙️ Backend] Generating sharing link for project ID: ${projectId}...`);
        const sharingLink = await generateSharingLink(projectId);
        if (!sharingLink) {
             logger.warn(`[⚙️ Backend] Failed to generate sharing link for project ${projectId}. Reply may not include link.`);
        }
        logger.info(`[⚙️ Backend] Sharing link generated: ${sharingLink || 'N/A'}`);

        // Return success with relevant URLs
        return { 
            success: true, 
            sharingLink: sharingLink || undefined, 
            publicMp3Url: publicMp3Url, // Will be undefined if download or S3 upload failed
            projectId 
        };

    } catch (error: any) {
        logger.error(`[⚙️ Backend] Error during backend processing for ${spaceId}:`, error);
        // Ensure temporary downloaded audio is cleaned up on error
        if (downloadedAudioPath) {
             logger.info(`[⚙️ Backend] Cleaning up temporary audio file due to error: ${downloadedAudioPath}`);
             await fs.unlink(downloadedAudioPath).catch(()=>{}); // Best effort cleanup
        }
        return { success: false, error: error.message || 'Unknown backend error' };
    }
}

// --- Queues & Workers --- 
/**
 * Adds a completed backend job to the final reply queue and triggers the worker.
 */
function addToFinalReplyQueue(mentionInfo: MentionInfo, backendResult: BackendResult) {
    logger.info(`[↩️ Reply Queue] Adding result for ${mentionInfo.tweetId} to reply queue. Success: ${backendResult.success}`);
    finalReplyQueue.push({ mentionInfo, backendResult });
    // Triggering is handled by the main browser task loop
}

/**
 * Processes the browser initiation steps for mentions (runs one at a time).
 */
async function runInitiationQueue(page: Page): Promise<void> {
    if (isInitiatingProcessing || mentionQueue.length === 0) {
        // logger.debug('[🚀 Initiate Queue] Worker skipped (already running or queue empty).')
        return; // Already running or queue empty
    }
    if (!page || page.isClosed()) {
        logger.error('[🚀 Initiate Queue] Page is closed! Cannot process initiation queue.');
        isInitiatingProcessing = false;
        return;
    }

    isInitiatingProcessing = true;
    logger.info(`[🚀 Initiate Queue] Starting worker. Queue size: ${mentionQueue.length}`);

    const mentionToProcess = mentionQueue.shift(); 
    if (!mentionToProcess) {
        isInitiatingProcessing = false;
        logger.warn('[🚀 Initiate Queue] Worker started but queue was empty.');
        return; // Should not happen, but safety check
    }

    logger.info(`[🚀 Initiate Queue] Processing mention ${mentionToProcess.tweetId}. Remaining: ${mentionQueue.length}`);
    
    try {
        // Perform browser initiation steps
        const initData = await initiateProcessing(mentionToProcess, page);
        
        // If initiation is successful, start backend processing asynchronously
        logger.info(`[🚀 Initiate Queue] Initiation successful for ${mentionToProcess.tweetId}. Starting background backend task.`);
        
        // No 'await' here - let it run in the background
        performBackendProcessing(initData)
            .then(backendResult => {
                addToFinalReplyQueue(mentionToProcess, backendResult);
            })
            .catch(backendError => {
                logger.error(`[💥 Backend ERROR] Uncaught error in background processing for ${mentionToProcess.tweetId}:`, backendError);
                // Add a failure result to the reply queue so we can notify the user
                addToFinalReplyQueue(mentionToProcess, { success: false, error: 'Backend processing failed unexpectedly' });
            });
            
    } catch (initError) {
        // Errors during initiateProcessing (including posting error replies) are logged within the function
        logger.error(`[🚀 Initiate Queue] Initiation phase failed explicitly for ${mentionToProcess.tweetId}. Error should already be logged.`);
        // Do not re-queue or add to reply queue if initiation failed, as an error reply was likely attempted.
    }

    logger.info(`[🚀 Initiate Queue] Finished browser initiation work for ${mentionToProcess.tweetId}.`);
    isInitiatingProcessing = false; // Free up the flag for the next check
}

/**
 * Processes the final reply queue (runs one at a time).
 */
async function runFinalReplyQueue(page: Page): Promise<void> { 
    if (isPostingFinalReply || finalReplyQueue.length === 0) {
        return; 
    }
    // Keep page check for Playwright path
    if (!config.USE_TWITTER_API_FOR_REPLY && (!page || page.isClosed())) {
        logger.error('[↩️ Reply Queue] Playwright Page is closed! Cannot process Playwright reply queue.');
        isPostingFinalReply = false;
        return;
    } 

    isPostingFinalReply = true;
    const postMethod = config.USE_TWITTER_API_FOR_REPLY ? 'API' : 'Playwright';
    logger.info(`[↩️ Reply Queue] Starting ${postMethod}-based reply worker. Queue size: ${finalReplyQueue.length}`);

    const replyData = finalReplyQueue.shift(); 
    if (!replyData) {
        isPostingFinalReply = false;
        logger.warn('[↩️ Reply Queue] Worker started but queue was empty.');
        return;
    }
    
    const { mentionInfo, backendResult } = replyData;
    logger.info(`[↩️ Reply Queue] Processing final reply for ${mentionInfo.tweetId}. Backend Success: ${backendResult.success}`);

    let finalMessage = '';
    // Media attachment is currently disabled by default via config
    let mediaPathToAttach: string | undefined = undefined;

    // Construct the final message based on success and link availability
    if (backendResult.success) {
        const languageName = getLanguageName(detectLanguage(mentionInfo.text)); 
        let links = [];
        if (backendResult.sharingLink) {
            links.push(`🎧 Listen/Watch: ${backendResult.sharingLink}`);
        }
        if (backendResult.publicMp3Url) {
            links.push(`🔊 Full MP3: ${backendResult.publicMp3Url}`);
        }
        
        if (links.length > 0) {
            // Construct success message with links
            finalMessage = `@${mentionInfo.username} Your ${languageName} dub is ready! 🎉 ${links.join(' | ')}`;
        } else {
            // Success but no links (edge case)
            finalMessage = `@${mentionInfo.username} Your ${languageName} dub processing finished, but link generation failed. 🤔 Please check the SpeechLab project directly (ID: ${backendResult.projectId || 'unknown'}).`;
             logger.warn(`[↩️ Reply Queue] Posting success reply for ${mentionInfo.tweetId} without any links.`);
        }
        
        // If we intended to attach video but couldn't (e.g., generation failed), mention it.
        if (config.POST_REPLY_WITH_VIDEO && !mediaPathToAttach) {
            finalMessage += ` (Video generation failed, sharing audio links only.)`;
        } 
        // Ensure message fits Twitter length (simple truncation for now)
        if (finalMessage.length > 280) {
             logger.warn(`[↩️ Reply Queue] Truncating final success message for tweet ${mentionInfo.tweetId} due to length.`);
             finalMessage = finalMessage.substring(0, 277) + '...'; 
        }

    } else {
        // Construct error message
        const errorReason = backendResult.error || 'processing failed';
         finalMessage = `@${mentionInfo.username} Oops! 😥 Couldn't complete the ${getLanguageName(detectLanguage(mentionInfo.text))} dub for this Space (${errorReason}). Maybe try again later?`;
         mediaPathToAttach = undefined; // Ensure no media attached on failure
    }

    // --- Posting Logic --- 
    let postSuccess = false;
    const TEMP_AUDIO_DIR = path.join(process.cwd(), 'temp_audio'); // Define for cleanup
    // Determine the path of the downloaded audio (needs reconstruction or passing)
    // This reconstruction is fragile! Ideally, pass the path via BackendResult.
    const sanitizedProjectName = (mentionInfo.text || `space_${mentionInfo.tweetId}`).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const targetLanguageCode = detectLanguage(mentionInfo.text);
    const thirdPartyID = `${sanitizedProjectName}-${targetLanguageCode}`;
    const assumedAudioFilename = `${thirdPartyID}_dubbed.mp3`;
    const assumedDownloadedAudioPath = path.join(TEMP_AUDIO_DIR, assumedAudioFilename);

    try {
        if (config.USE_TWITTER_API_FOR_REPLY) {
            logger.info(`[↩️ Reply Queue] Posting final reply via API to tweet ID ${mentionInfo.tweetId}...`);
            postSuccess = await postTweetReplyWithMediaApi(
                finalMessage,
                mentionInfo.tweetId, 
                mediaPathToAttach // Pass the media path if available
            );
        } else {
            logger.info(`[↩️ Reply Queue] Posting final reply via Playwright to tweet URL ${mentionInfo.tweetUrl}...`);
            postSuccess = await postReplyToTweet(
                page, 
                mentionInfo.tweetUrl, 
                finalMessage, 
                mediaPathToAttach // Pass the media path if available
            );
        }
        
        if (postSuccess) {
            logger.info(`[↩️ Reply Queue] Successfully posted final reply via ${postMethod} for ${mentionInfo.tweetId}.`);
            
            // --- ADDED: Mark as processed ONLY AFTER successful reply ---
            try {
                await markMentionAsProcessed(mentionInfo.tweetId, processedMentions); 
            } catch (markError) {
                logger.error(`[↩️ Reply Queue] CRITICAL: Failed to mark mention ${mentionInfo.tweetId} as processed after successful reply:`, markError);
                // Continue cleanup even if marking fails
            }
            // --- END ADDED SECTION ---

            // --- Clean up DOWNLOADED MP3 --- 
            // Attempt cleanup using the reconstructed path
            logger.info(`[↩️ Reply Queue] Attempting cleanup of temporary audio file: ${assumedDownloadedAudioPath}`);
            try {
                 // Check if it exists before unlinking
                 await fs.access(assumedDownloadedAudioPath);
                 await fs.unlink(assumedDownloadedAudioPath);
                 logger.info(`[↩️ Reply Queue] Successfully deleted temporary audio file.`);
            } catch (err) {
                 logger.warn(`[↩️ Reply Queue] Failed to delete or access temp audio ${assumedDownloadedAudioPath} (may have already been deleted or reconstruction failed):`, err);
            }
            // -----------------------------
        } else {
             logger.warn(`[↩️ Reply Queue] Failed to post final ${postMethod} reply for ${mentionInfo.tweetId}.`);
        }
    } catch (replyError) {
        logger.error(`[↩️ Reply Queue] CRITICAL: Error posting final ${postMethod} reply for ${mentionInfo.tweetId}:`, replyError);
    } finally {
        logger.info(`[↩️ Reply Queue] Finished ${postMethod} reply work for ${mentionInfo.tweetId}.`);
        isPostingFinalReply = false; 
    }
}

// --- Trigger Functions (Called by main loop to avoid deep recursion) ---
function triggerInitiationWorker(page: Page | null) {
    if (page && !page.isClosed() && !isInitiatingProcessing && mentionQueue.length > 0) {
        logger.debug('[🚀 Initiate Queue Trigger] Triggering check...');
        runInitiationQueue(page).catch(err => {
             logger.error('[🚀 Initiate Queue Trigger] Unhandled error in worker execution:', err);
             isInitiatingProcessing = false; // Reset flag on error
        });
    } else {
        // logger.debug('[🚀 Initiate Queue Trigger] Worker not triggered (busy, empty, or page closed).');
    }
}

function triggerFinalReplyWorker(page: Page | null) {
     if (page && !page.isClosed() && !isPostingFinalReply && finalReplyQueue.length > 0) {
         logger.debug('[↩️ Reply Queue Trigger] Triggering check...');
         runFinalReplyQueue(page).catch(err => {
             logger.error('[↩️ Reply Queue Trigger] Unhandled error in worker execution:', err);
             isPostingFinalReply = false; // Reset flag on error
         });
    } else {
        // logger.debug('[↩️ Reply Queue Trigger] Reply worker not triggered (busy, empty, or page closed).');
    }
}

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
    let mainLoopIntervalId: NodeJS.Timeout | null = null; // Keep track of main polling interval
    let browserTaskIntervalId: NodeJS.Timeout | null = null; // Keep track of browser task interval

    // Graceful shutdown handler
    const shutdown = async (signal: string) => {
        logger.info(`[😈 Daemon] Received ${signal}. Shutting down gracefully...`);
        if (mainLoopIntervalId) clearInterval(mainLoopIntervalId);
        mainLoopIntervalId = null; // Prevent further polling calls
        if (browserTaskIntervalId) clearInterval(browserTaskIntervalId);
        browserTaskIntervalId = null; // Prevent further browser task calls

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

        let isLoggedIn: boolean | undefined = undefined; // Declare variable here

        // Check if we're already logged in from saved state - trying /home again
        logger.info('[😈 Daemon] Checking if already logged in via /home page (domcontentloaded)...');
        try {
            // Navigate to home - wait for DOM content load
            await page.goto('https://twitter.com/home', { waitUntil: 'domcontentloaded', timeout: 90000 }); // Keep navigation timeout longer
            logger.info('[😈 Daemon] Successfully navigated to /home page structure.');
            // Wait longer for dynamic elements to potentially render after DOM load
            logger.info('[😈 Daemon] Waiting 60 seconds for dynamic content...'); 
            await page.waitForTimeout(60000); // Set wait to 60 seconds

            // Check multiple indicators for login success
            const successIndicators = [
                '[data-testid="primaryColumn"]',                // Main content column
                'aside[aria-label*="Account menu"]',            // Account menu button container
                '[data-testid="SideNav_NewTweet_Button"]'       // Tweet button
            ];
            
            logger.info('[😈 Daemon] Performing login check with multiple selectors...');
            for (const selector of successIndicators) {
                logger.debug(`[😈 Daemon] Checking login indicator: ${selector}`);
                 // Increase timeout for visibility check
                if (await page.locator(selector).first().isVisible({ timeout: 60000 }).catch(() => false)) { // Set visibility check to 60s
                    logger.info(`[😈 Daemon] ✅ Already logged in from saved state! (Verified via /home, indicator: ${selector})`);
                    isLoggedIn = true;
                    break; // Stop checking once one indicator is found
                }
            }

            if (isLoggedIn) {
                 await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-login-check-home-success.png') });
            } else {
                 logger.warn('[😈 Daemon] ❌ Login check failed: No success indicators visible on /home.');
                 isLoggedIn = false;
                 await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-login-check-home-fail.png') });
            }

        } catch (navError) {
            logger.warn('[😈 Daemon] Timeout or error navigating to /home for login check. Assuming not logged in.', navError);
            try { // Best effort screenshot on error
                 await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'daemon-login-check-home-nav-error.png') });
            } catch {}
            isLoggedIn = false; // Explicitly set false on navigation error
        }
       
        
        // Throw error if cookie check failed
        if (isLoggedIn !== true) {
             throw new Error('Cookie-based login check failed. Please ensure valid cookies exist in cookies/twitter-cookies.json. Daemon cannot continue.');
        }

        logger.info('[😈 Daemon] Twitter login confirmed via cookies. Ready to monitor mentions.');

        // --- Main Polling Loop --- 
        logger.info(`[😈 Daemon] Starting mention polling loop (Interval: ${POLLING_INTERVAL_MS / 1000}s)`);
        const pollMentions = async () => {
             if (!page || page.isClosed()) { 
                 logger.error('[😈 Daemon Polling] Page closed. Stopping polling loop.');
                 if (mainLoopIntervalId) clearInterval(mainLoopIntervalId);
                 mainLoopIntervalId = null;
                 if (browserTaskIntervalId) clearInterval(browserTaskIntervalId);
                 browserTaskIntervalId = null;
                 await shutdown('Polling Page Closed');
                return; 
            }
            logger.info('[😈 Daemon Polling] Polling for new mentions...');
            try {
                const mentions = await scrapeMentions(page);
                logger.info(`[😈 Daemon Polling] Scraped ${mentions.length} mentions.`);
                logger.debug(`[😈 Daemon Polling] Current processedMentions set size: ${processedMentions.size}`); // Log set size
                let newMentionsFound = 0;
                for (const mention of mentions) {
                    // --- ADDED: Detailed logging before check ---
                    const currentTweetId = mention.tweetId;
                    const isAlreadyProcessed = processedMentions.has(currentTweetId);
                    logger.debug(`[😈 Daemon Polling] Checking mention ID: ${currentTweetId}. Already processed according to Set: ${isAlreadyProcessed}`);
                    // --- END ADDED LOGGING ---
                    
                    if (!isAlreadyProcessed) { // Use the pre-checked variable
                        newMentionsFound++;
                        logger.info(`[🔔 Mention] Found new mention: ID=${currentTweetId}, User=${mention.username}`);
                             mentionQueue.push(mention);
                        logger.info(`[⚙️ Queue] Mention ${currentTweetId} added to initiation queue. Queue size: ${mentionQueue.length}`);
                    } 
                }
                 if (newMentionsFound > 0) {
                    logger.info(`[😈 Daemon Polling] Added ${newMentionsFound} new mentions to the queue.`);
                    // Trigger initiation worker check immediately after finding new mentions
                    // The browser task loop will handle actually running it if idle
                    // triggerInitiationWorker(page); 
                    } else {
                      logger.info('[😈 Daemon Polling] No new mentions found.');
                    }
            } catch (error) {
                logger.error('[😈 Daemon Polling] Error during mention polling cycle:', error);
                 // Basic recovery attempt
                 try {
                     if (page && !page.isClosed()) {
                         await page.goto('https://twitter.com/home', { waitUntil: 'domcontentloaded', timeout: 15000 });
                         logger.info('[😈 Daemon Polling] Attempted recovery by navigating home.');
                     } else {
                         throw new Error('Page closed during polling error handling.');
                     }
                     } catch (recoveryError) {
                     logger.error('[😈 Daemon Polling] Recovery failed. Stopping polling.', recoveryError);
                     await shutdown('Polling Recovery Failed');
                 }
            }
        };

        // Initial poll, then set interval
        await pollMentions(); 
        mainLoopIntervalId = setInterval(pollMentions, POLLING_INTERVAL_MS);

        // --- Browser Task Worker Loop --- 
        // Separate interval to trigger browser-based queue workers (initiation & final reply)
        // This ensures they don't block the main polling loop and manage page access.
        const BROWSER_TASK_INTERVAL_MS = 5000; // Check queues every 5 seconds
        logger.info(`[😈 Daemon] Starting browser task worker loop (Interval: ${BROWSER_TASK_INTERVAL_MS / 1000}s)`);
        browserTaskIntervalId = setInterval(() => {
            // logger.debug('[😈 Daemon Task Loop] Checking queues for browser tasks...');
            if (!page || page.isClosed()) {
                logger.error('[😈 Daemon Task Loop] Page is closed. Stopping task loop.');
                if (browserTaskIntervalId) clearInterval(browserTaskIntervalId);
                browserTaskIntervalId = null;
                // Consider triggering shutdown
                return;
            }
            
            // Check flags: Prioritize initiating if possible, then replying
            if (!isInitiatingProcessing && !isPostingFinalReply) { // Only trigger if browser is idle
                if (mentionQueue.length > 0) {
                    logger.debug('[😈 Daemon Task Loop] Triggering Initiation Queue check...');
                    triggerInitiationWorker(page);
                } else if (finalReplyQueue.length > 0) {
                    logger.debug('[😈 Daemon Task Loop] Triggering Final Reply Queue check...');
                    triggerFinalReplyWorker(page);
                } else {
                   // logger.debug('[😈 Daemon Task Loop] Browser idle, queues empty.');
                }
            } else {
                 // logger.debug(`[😈 Daemon Task Loop] Browser busy (Initiating: ${isInitiatingProcessing}, Replying: ${isPostingFinalReply}). Skipping triggers.`);
            }
        }, BROWSER_TASK_INTERVAL_MS);

        logger.info('[😈 Daemon] Daemon initialization complete. Monitoring mentions...');

    } catch (error) {
        logger.error('[😈 Daemon] Daemon encountered fatal error during initialization or polling:', error);
        // Ensure cleanup happens on fatal error
        if (mainLoopIntervalId) clearInterval(mainLoopIntervalId); 
        if (browserTaskIntervalId) clearInterval(browserTaskIntervalId); 
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
     if (mainLoopIntervalId || browserTaskIntervalId) {
         await new Promise(() => {}); // Keep alive indefinitely
     } else {
          logger.info('[😈 Daemon] Interval timer not set or cleared. Exiting.');
          process.exit(0); // Exit if polling stopped
     }
}

main(); 