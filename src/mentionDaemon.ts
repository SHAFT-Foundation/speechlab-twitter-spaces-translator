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
import { downloadAndUploadAudio, prepareAudioForTranscription, PreparedAudioInfo, uploadLocalFileToS3 } from './services/audioService';
import { 
    createDubbingProject, 
    waitForProjectCompletion, 
    generateSharingLink, 
    getProjectByThirdPartyID,
    createProjectAndTranscribe,
    waitForTranscriptionCompletion,
    CreateProjectAndTranscribePayload,
    Project // Ensure Project type is imported if used directly in performBackendProcessing
} from './services/speechlabApiService';
import { detectLanguage, detectLanguages, getLanguageName } from './utils/languageUtils';
import { v4 as uuidv4 } from 'uuid';
import { postTweetReplyWithMediaApi } from './services/twitterApiService';
import * as fsExtra from 'fs-extra';
import { summarizeText } from './services/openaiService';

// --- Queues & Workers Data Structures ---
const mentionQueue: MentionInfo[] = []; // Queue for incoming mentions
const finalReplyQueue: { mentionInfo: MentionInfo, backendResult: BackendResult }[] = []; // Queue for final replies
let isInitiatingProcessing = false; // Flag for browser task (initiation)
let isPostingFinalReply = false;   // Flag for browser task (final reply)

// --- Added for better queue logging ---
let processedCount = 0; // Track how many mentions processed since startup
// --- End added section ---

// --- MOVED: Global Set for Processed Mentions ---
let processedMentions: Set<string> = new Set();
// --- END MOVED SECTION ---

// Interface for data passed from initiation to backend
interface InitiationResult {
    m3u8Url: string;
    spaceId: string;
    spaceTitle: string | null;
    mentionInfo: MentionInfo; // Pass original mention info
    sourceLanguageCode: string;
    sourceLanguageName: string;
    targetLanguageCode: string;
    targetLanguageName: string;
    processingType: 'dubbing' | 'summarization'; // Added
}
// Interface for backend result
interface BackendResult {
    type: 'dubbing' | 'summarization' | 'failure';
    success: boolean;
    sharingLink?: string;   // Link to SpeechLab project page
    publicMp3Url?: string;  // Link to the uploaded dubbed MP3 on S3
    projectId?: string;
    thirdPartyID?: string;  // Added thirdPartyID to track in processed mentions
    error?: string;
    summaryText?: string; // Added for summarization
    originalTweetUrl?: string; // Added for summarization
    // Path to the FINAL generated video file
    // generatedVideoPath?: string; 
}

// New interfaces for processed mentions tracking
interface ProcessedMentionData {
    mentions: string[];
    projects: Record<string, ProjectStatusInfo>;
}

interface ProjectStatusInfo {
    thirdPartyID: string;
    projectId?: string;
    status: 'initiated' | 'processing' | 'complete' | 'failed' | 'transcribing' | 'summarizing' | 'complete_summary' | 'failed_transcription' | 'failed_summarization'; // Added new states
    createdAt: string;
    updatedAt: string;
    mentionIds: string[];
    processingType?: 'dubbing' | 'summarization'; // Track what kind of job this is
}

const PROCESSED_MENTIONS_PATH = path.join(process.cwd(), 'processed_mentions.json');
const POLLING_INTERVAL_MS = (config.NODE_ENV === 'development' ? 1 : 10) * 60 * 1000; // Dev: 1 min, Prod: 10 min
const SCREENSHOT_DIR = path.join(process.cwd(), 'debug-screenshots');
const MANUAL_LOGIN_WAIT_MS = 60 * 1000; // Wait 60 seconds for manual login if needed

const ERROR_LOG_PATH = path.join(process.cwd(), 'error_log.json');

/**
 * Log error for a specific mention to prevent reprocessing
 * @param mentionId The mention ID that failed
 * @param error The error message or object
 * @param phase The processing phase where the error occurred
 */
async function logMentionError(mentionId: string, error: any, phase: 'initiation' | 'backend' | 'reply'): Promise<void> {
    try {
        let errorLog: Record<string, any> = {};
        
        // Load existing errors if file exists
        if (await fsExtra.pathExists(ERROR_LOG_PATH)) {
            const data = await fsExtra.readFile(ERROR_LOG_PATH, 'utf-8');
            try {
                errorLog = JSON.parse(data);
            } catch (parseError) {
                logger.error(`[❌ Error Log] Failed to parse error log JSON: ${parseError}`);
                errorLog = {};
            }
        }
        
        // Format error message
        let errorMessage = '';
        if (error instanceof Error) {
            errorMessage = `${error.name}: ${error.message}`;
            if (error.stack) {
                errorMessage += `\n${error.stack}`;
            }
        } else if (typeof error === 'string') {
            errorMessage = error;
        } else {
            errorMessage = JSON.stringify(error);
        }
        
        // Add or update error entry
        errorLog[mentionId] = {
            phase,
            error: errorMessage,
            timestamp: new Date().toISOString(),
            count: (errorLog[mentionId]?.count || 0) + 1
        };
        
        // Write back to file
        await fsExtra.writeFile(ERROR_LOG_PATH, JSON.stringify(errorLog, null, 2));
        logger.info(`[❌ Error Log] Logged error for mention ${mentionId} in phase ${phase}`);
        
        // Also mark the mention as processed to prevent reprocessing
        await markMentionAsProcessed(mentionId, processedMentions);
        logger.info(`[❌ Error Log] Marked failed mention ${mentionId} as processed to prevent requeuing`);
    } catch (logError) {
        logger.error(`[❌ Error Log] Failed to log error for mention ${mentionId}: ${logError}`);
    }
}

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
 * Loads processed mention IDs and project status info from the JSON file.
 * Creates the file if it doesn't exist.
 */
async function loadProcessedMentions(): Promise<Set<string>> {
    try {
        await fs.access(PROCESSED_MENTIONS_PATH);
        const data = await fs.readFile(PROCESSED_MENTIONS_PATH, 'utf-8');
        let mentionData: ProcessedMentionData;
        
        try {
            mentionData = JSON.parse(data);
            // Check if data has the new structure, if not convert it
            if (!mentionData.mentions && Array.isArray(mentionData)) {
                logger.info(`[😈 Daemon] Converting old processed_mentions.json format to new structure.`);
                mentionData = {
                    mentions: mentionData as any, // Convert the array directly to mentions
                    projects: {}
                };
                // Save the converted structure
                await fs.writeFile(PROCESSED_MENTIONS_PATH, JSON.stringify(mentionData, null, 2));
            }
        } catch (parseError) {
            logger.error(`[😈 Daemon] Error parsing ${PROCESSED_MENTIONS_PATH}, creating new structure:`, parseError);
            mentionData = { mentions: [], projects: {} };
            await fs.writeFile(PROCESSED_MENTIONS_PATH, JSON.stringify(mentionData, null, 2));
        }
        
        logger.info(`[😈 Daemon] Loaded ${mentionData.mentions.length} processed mention IDs and ${Object.keys(mentionData.projects).length} project statuses from ${PROCESSED_MENTIONS_PATH}.`);
        return new Set(mentionData.mentions);
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            logger.info(`[😈 Daemon] ${PROCESSED_MENTIONS_PATH} not found. Creating a new one with updated structure.`);
            const newData: ProcessedMentionData = { mentions: [], projects: {} };
            await fs.writeFile(PROCESSED_MENTIONS_PATH, JSON.stringify(newData, null, 2));
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
        // Load the current data first
        await fs.access(PROCESSED_MENTIONS_PATH);
        const data = await fs.readFile(PROCESSED_MENTIONS_PATH, 'utf-8');
        let mentionData: ProcessedMentionData;
        
        try {
            mentionData = JSON.parse(data);
            // Ensure proper structure
            if (!mentionData.mentions) {
                mentionData = { mentions: [], projects: {} };
            }
        } catch (parseError) {
            mentionData = { mentions: [], projects: {} };
        }
        
        // Add the new mention ID to the array if not already there
        if (!mentionData.mentions.includes(mentionId)) {
            mentionData.mentions.push(mentionId);
        }
        
        await fs.writeFile(PROCESSED_MENTIONS_PATH, JSON.stringify(mentionData, null, 2));
        logger.debug(`[😈 Daemon] Marked mention ${mentionId} as processed and saved to file.`);
    } catch (error) {
        logger.error(`[😈 Daemon] Error saving processed mention ${mentionId} to ${PROCESSED_MENTIONS_PATH}:`, error);
        // Remove from the set in memory if save fails to allow retry on next poll
        processedMentions.delete(mentionId);
        logger.warn(`[😈 Daemon] Removed ${mentionId} from in-memory set due to save failure.`);
    }
}

/**
 * Updates project status information in the processed mentions file.
 * @param thirdPartyID The unique third-party ID used to identify the project
 * @param projectId The SpeechLab project ID (optional)
 * @param status The current status of the project
 * @param mentionId The mention ID associated with this project
 */
async function updateProjectStatus(
    thirdPartyID: string, 
    status: ProjectStatusInfo['status'], // Use the full status type
    mentionId: string, // The specific mention ID that triggered this status update or is associated
    projectId?: string,
    processingType?: 'dubbing' | 'summarization' // Optional: specify if known, useful for new projects
): Promise<void> {
    logger.info(`[😈 Daemon] Updating project status: thirdPartyID=${thirdPartyID}, projectId=${projectId || 'N/A'}, status=${status}, mentionId=${mentionId}` + (processingType ? `, type=${processingType}` : ''));
    
    try {
        await fsExtra.ensureFile(PROCESSED_MENTIONS_PATH); // Ensures file exists, creates if not
        const data = await fsExtra.readFile(PROCESSED_MENTIONS_PATH, 'utf-8');
        let mentionData: ProcessedMentionData;
        
        try {
            mentionData = data ? JSON.parse(data) : { mentions: [], projects: {} };
            if (!mentionData.projects) mentionData.projects = {};
            if (!mentionData.mentions) mentionData.mentions = [];
        } catch (parseError) {
            logger.warn(`[😈 Daemon] Error parsing ${PROCESSED_MENTIONS_PATH}, initializing with empty structure. Error: ${parseError}`);
            mentionData = { mentions: [], projects: {} };
        }
        
        const now = new Date().toISOString();
        
        if (mentionData.projects[thirdPartyID]) {
            const project = mentionData.projects[thirdPartyID];
            if (project.status !== status) {
                logger.info(`[😈 Daemon] Project ${thirdPartyID} status changing: ${project.status} → ${status}`);
            }
            project.status = status;
            project.updatedAt = now;
            if (projectId && !project.projectId) project.projectId = projectId;
            if (!project.mentionIds.includes(mentionId)) project.mentionIds.push(mentionId);
            // Update processingType if provided and not already set, or if it's different (though should be consistent for a thirdPartyID)
            if (processingType && (!project.processingType || project.processingType !== processingType)) {
                project.processingType = processingType;
            }
        } else {
            logger.info(`[😈 Daemon] Creating new project tracking: thirdPartyID=${thirdPartyID}, status=${status}, type=${processingType || 'unknown'}`);
            mentionData.projects[thirdPartyID] = {
                thirdPartyID,
                projectId,
                status,
                createdAt: now,
                updatedAt: now,
                mentionIds: [mentionId],
                processingType: processingType, // Set it here for new projects
            };
        }
        
        await fsExtra.writeFile(PROCESSED_MENTIONS_PATH, JSON.stringify(mentionData, null, 2));
        logger.info(`[😈 Daemon] Successfully updated project status for ${thirdPartyID} to ${status}.`);
    } catch (error) {
        logger.error(`[😈 Daemon] Error updating project status for ${thirdPartyID}:`, error);
    }
}

/**
 * Checks if a project with the given thirdPartyID exists and retrieves its status.
 * @param thirdPartyID The unique third-party ID 
 * @returns The project status info or null if not found
 */
async function getProjectStatus(thirdPartyID: string): Promise<ProjectStatusInfo | null> {
    try {
        await fs.access(PROCESSED_MENTIONS_PATH);
        const data = await fs.readFile(PROCESSED_MENTIONS_PATH, 'utf-8');
        let mentionData: ProcessedMentionData;
        
        try {
            mentionData = JSON.parse(data);
            
            // Check if project exists
            if (mentionData.projects && mentionData.projects[thirdPartyID]) {
                return mentionData.projects[thirdPartyID];
            }
        } catch (parseError) {
            logger.error(`[😈 Daemon] Error parsing processed mentions file while checking project status:`, parseError);
        }
        
        return null;
    } catch (error) {
        logger.error(`[😈 Daemon] Error checking project status for ${thirdPartyID}:`, error);
        return null;
    }
}

/**
 * Helper to find the article OR the direct button for playing a Space recording.
 * Prioritizes finding within an article, then falls back to searching the whole page.
 * @returns A Locator for either the containing article OR the button itself, or null.
 */
async function findArticleWithPlayButton(page: Page): Promise<Locator | null> {
    logger.debug('[🐦 Helper] Searching for playable Space element (button or article)...');
    
    const playButtonNameRegex = /Play recording/i; // Case-insensitive regex
    const articleSelector = 'article[data-testid="tweet"]';
    const flexibleButtonXPath = "//button[contains(@aria-label, 'Play recording') or .//span[contains(text(), 'Play recording')]]";

    // --- Strategy 1: Find button within articles using getByRole --- 
    logger.debug(`[🐦 Helper] Strategy 1: Searching within articles (${articleSelector}) using getByRole...`);
    const articles = await page.locator(articleSelector).all();
    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        if (!await article.isVisible().catch(() => false)) {
             logger.debug(`[🐦 Helper] Article ${i + 1} is not visible, skipping.`);
             continue;
         }
        const buttonInArticle = article.getByRole('button', { name: playButtonNameRegex }).first();
        if (await buttonInArticle.isVisible({ timeout: 500 })) {
            logger.info(`[🐦 Helper] Found Play button in article ${i + 1} using getByRole. Returning article.`);
            return article; // Return the article containing the button
        }
    }

    // --- Strategy 2: Find button directly on page using getByRole --- 
    logger.info('[🐦 Helper] Strategy 2: Searching page-level using getByRole...');
    const buttonByRole = page.getByRole('button', { name: playButtonNameRegex }).first();
    if (await buttonByRole.isVisible({ timeout: 1000 })) {
        logger.info('[🐦 Helper] Found Play button using getByRole directly on page. Returning button locator.');
        return buttonByRole;
    }
    
    // --- Strategy 3: Find button directly on page using flexible XPath --- 
    logger.info('[🐦 Helper] Strategy 3: Searching page-level using flexible XPath...');
    const buttonByXPath = page.locator(flexibleButtonXPath).first();
    if (await buttonByXPath.isVisible({ timeout: 1000 })) {
        logger.info('[🐦 Helper] Found Play button using flexible XPath directly on page. Returning button locator.');
        return buttonByXPath;
    }

    // --- Deprecated Selectors (kept for reference, commented out) ---
    // const playRecordingSelectors = [
    //     'button[aria-label*="Play recording"]'
    // ];
    // const nestedButtonSelector = 'button[aria-label*="Play recording"]:has(button:has-text("Play recording"))';

    logger.warn('[🐦 Helper] Could not find any playable element using getByRole or XPath strategies.');
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
async function initiateProcessing(mentionInfo: MentionInfo, page: Page): Promise<InitiationResult | null> { // Can return null if basic checks fail
    logger.info(`[🚀 Initiate] Starting browser phase for ${mentionInfo.tweetId} by ${mentionInfo.username}`);
    let playElementLocator: Locator | null = null;

    // --- Determine Processing Type --- 
    let processingType: 'dubbing' | 'summarization' = 'dubbing'; // Default to dubbing
    if (mentionInfo.text && mentionInfo.text.toLowerCase().includes('summarize')) {
        processingType = 'summarization';
        logger.info(`[🚀 Initiate] Detected 'summarize' intent for ${mentionInfo.tweetId}. Type: SUMMARIZATION.`);
    } else {
        logger.info(`[🚀 Initiate] No 'summarize' intent detected for ${mentionInfo.tweetId}. Type: DUBBING.`);
    }
    // --- End Determine Processing Type ---

    const { sourceLanguageCode, sourceLanguageName, targetLanguageCode, targetLanguageName } = detectLanguages(mentionInfo.text);
    logger.info(`[🚀 Initiate] Detected languages: Source: ${sourceLanguageName} (${sourceLanguageCode}), Target: ${targetLanguageName} (${targetLanguageCode}) (Note: Target lang relevant for dubbing)`);

    // 1. Navigate & Find Playable Element
    try {
        logger.info(`[🚀 Initiate] Navigating to mention tweet: ${mentionInfo.tweetUrl}`);
        await page.goto(mentionInfo.tweetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForTimeout(config.NODE_ENV === 'development' ? 5000 : 30000); // Shorter wait for dev

        playElementLocator = await findArticleWithPlayButton(page);
        if (!playElementLocator) {
            logger.info('[🚀 Initiate] Play button/article not immediately visible. Scrolling up...');
            const MAX_SCROLL_UP = 3; // Reduced scroll attempts
            for (let i = 0; i < MAX_SCROLL_UP && !playElementLocator; i++) {
                await page.evaluate(() => window.scrollBy(0, -window.innerHeight / 2)); // Scroll less aggressively
                await page.waitForTimeout(config.NODE_ENV === 'development' ? 3000 : 15000);
                playElementLocator = await findArticleWithPlayButton(page);
            }
        }

        if (!playElementLocator) {
            const errMsg = `Could not find playable Space element for tweet ${mentionInfo.tweetId}. Cannot proceed with ${processingType}.`;
            logger.warn(`[🚀 Initiate] ${errMsg}`);
            const errorReplyText = `${mentionInfo.username} Sorry, I couldn't find a playable Twitter Space with this tweet.`;
            logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
            await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
            // No throw here, return null to signal to runInitiationQueue to log error and mark processed
            return null; 
        }
        logger.info(`[🚀 Initiate] Found potential Space element.`);

    } catch (error) {
        logger.error(`[🚀 Initiate] Error during navigation/element finding for ${mentionInfo.tweetId}:`, error);
        try {
            const errorReplyText = `${mentionInfo.username} Sorry, I had trouble loading the tweet to find the Space.`;
            logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
            await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
        } catch (replyError) { logger.warn(`[🚀 Initiate] Failed to post error reply after navigation error: ${replyError}`); }
        return null; // Signal failure
    }
    
    let spaceTitle: string | null = null;
    // ... (title extraction logic remains the same - trying pre-click and modal) ...
    // (This part is long, assuming it remains as is for now for brevity, will be included in final edit)
    try {
        logger.debug(`[🚀 Initiate] Attempting to extract Space title from located element (pre-click)...`);
        const tagName = await playElementLocator.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
        if (tagName === 'button') {
            const ariaLabel = await playElementLocator.getAttribute('aria-label');
            const prefix = 'Play recording of ';
            if (ariaLabel && ariaLabel.startsWith(prefix)) {
                const potentialTitle = ariaLabel.substring(prefix.length).trim();
                if (potentialTitle) spaceTitle = potentialTitle.substring(0, 150);
            }
        }
        if (!spaceTitle) {
            const tweetTextElement = playElementLocator.locator('div[data-testid="tweetText"]').first();
            if (await tweetTextElement.isVisible({ timeout: 1000 })) {
                const potentialTitle = await tweetTextElement.textContent({ timeout: 1000 });
                if (potentialTitle) spaceTitle = potentialTitle.trim().replace(/^@[^\\s]+\\s*/, '').substring(0, 150);
            }
        }
    } catch (titleError) {logger.warn('[🚀 Initiate] Error during pre-click title extraction:', titleError); }

    let m3u8Url: string | null = null;
    try {
        logger.info(`[🚀 Initiate] Clicking Play button and capturing M3U8...`);
        m3u8Url = await clickPlayButtonAndCaptureM3u8(page, playElementLocator);
        if (!m3u8Url) {
            const errMsg = `Failed to capture M3U8 URL for tweet ${mentionInfo.tweetId}. Cannot proceed with ${processingType}.`;
            logger.error(`[🚀 Initiate] ${errMsg}`);
            const errorReplyText = `${mentionInfo.username} Sorry, I found the Space but couldn't get its audio stream.`;
            logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
            await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
            return null; // Signal failure
        }
        logger.info(`[🚀 Initiate] Captured M3U8 URL.`);
        
        if (!spaceTitle) { // Try modal title extraction only if pre-click failed
            try {
                await page.waitForTimeout(config.NODE_ENV === 'development' ? 2000 : 5000);
                const modalTitle = await extractSpaceTitleFromModal(page);
                if (modalTitle) spaceTitle = modalTitle;
            } catch (modalTitleError) { logger.warn('[🚀 Initiate] Error extracting Space title from modal:', modalTitleError); }
        }
    } catch (error) {
         logger.error(`[🚀 Initiate] Error during M3U8 capture for ${mentionInfo.tweetId}:`, error);
         try {
             const errorReplyText = `${mentionInfo.username} Sorry, an error occurred while accessing the Space audio.`;
             await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
         } catch(replyError) { logger.warn(`[🚀 Initiate] Failed to post error reply after M3U8 error: ${replyError}`); }
         return null; // Signal failure
    }

    const spaceId = m3u8Url.match(/([a-zA-Z0-9_-]+)\/(?:chunk|playlist)/)?.[1] || `space_${mentionInfo.tweetId || uuidv4()}`;
    logger.info(`[🚀 Initiate] Using Space ID: ${spaceId}. Final Space title for processing: "${spaceTitle || 'Untitled Space'}"`);

    // Post preliminary acknowledgement reply (generic for now)
    try {
        logger.info(`[🚀 Initiate] Posting preliminary acknowledgement reply...`);
        const ackMessageBase = `${mentionInfo.username} Got it! Starting to process this Space.`;
        const ackMessage = processingType === 'dubbing' ? 
            `${ackMessageBase} I'll dub it from ${sourceLanguageName} to ${targetLanguageName}. Check back in ~10-15 mins.`:\
            `${ackMessageBase} I'll work on summarizing it. Check back in a bit for the summary.`;
        logger.info(`[🚀 Initiate] Full Ack Reply Text: ${ackMessage}`);
        await postReplyToTweet(page, mentionInfo.tweetUrl, ackMessage);
    } catch (ackError) {
        logger.warn(`[🚀 Initiate] Error posting acknowledgement reply (non-critical):`, ackError);
    }

    logger.info(`[🚀 Initiate] Browser phase complete for ${mentionInfo.tweetId}. Type: ${processingType}.`);
    return {
        m3u8Url,
        spaceId,
        spaceTitle,
        mentionInfo,
        sourceLanguageCode,
        sourceLanguageName,
        targetLanguageCode, // Will be used by dubbing flow
        targetLanguageName, // Will be used by dubbing flow
        processingType,
    };
}
// --- END MODIFIED initiateProcessing ---

// --- NEW FUNCTION: Backend Processing Function (No Browser) --- 
/**
 * Handles backend processing: download, upload, SpeechLab tasks, and video download.
 * Does NOT interact with the browser page.
 */
async function performBackendProcessing(initData: InitiationResult): Promise<BackendResult> {
    const { m3u8Url, spaceId, spaceTitle, sourceLanguageCode, targetLanguageCode, mentionInfo, thirdPartyID: existingThirdPartyID } = initData as any; // Cast for now, ensure initData has thirdPartyID if needed
    // Ensure thirdPartyID is correctly derived or passed if this function is reused without modification for new logic
    const projectName = spaceTitle || `Twitter Space ${spaceId}`;
    const sanitizedProjectName = projectName.toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    // THIS thirdPartyID is specific to DUBBING
    const dubbingThirdPartyID = existingThirdPartyID || `${sanitizedProjectName}-${sourceLanguageCode}-to-${targetLanguageCode}`;

    logger.info(`[⚙️ Dubbing Backend] Starting for Space ID: ${spaceId}, 3rdPartyID: ${dubbingThirdPartyID}`);

    let downloadedAudioPath: string | undefined = undefined;
    // let generatedVideoPath: string | undefined = undefined;
    let publicMp3Url: string | undefined = undefined;
    let projectId: string | null = null; // Initialize projectId
    
    // Initialize thirdPartyID at the top level
    const projectName = spaceTitle || `Twitter Space ${spaceId}`; 
    const sanitizedProjectName = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const thirdPartyID = `${sanitizedProjectName}-${sourceLanguageCode}-to-${targetLanguageCode}`;

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
        
        // First check our local status tracking
        logger.info(`[⚙️ Backend] Checking local project status for thirdPartyID: ${thirdPartyID}...`);
        const existingProjectStatus = await getProjectStatus(thirdPartyID);
        
        if (existingProjectStatus) {
            logger.info(`[⚙️ Backend] ✅ Found existing project tracking: ${JSON.stringify(existingProjectStatus)}`);
            
            // Check the status to decide what to do
            if (existingProjectStatus.status === 'complete') {
                logger.info(`[⚙️ Backend] Project already completed successfully, no need to process again.`);
                projectId = existingProjectStatus.projectId || null;
                
                // Return success immediately, client can use the existing project data
                if (projectId) {
                    const sharingLink = await generateSharingLink(projectId);
                    return { 
                        type: 'dubbing', 
                        success: true, 
                        sharingLink: sharingLink || undefined,
                        projectId: projectId,
                        thirdPartyID: thirdPartyID
                    };
                }
            } else if (existingProjectStatus.status === 'failed') {
                logger.info(`[⚙️ Backend] Previous project attempt failed. Will retry processing.`);
                // Continue with processing to retry
            } else {
                logger.info(`[⚙️ Backend] Project is already being processed (status: ${existingProjectStatus.status}).`);
                projectId = existingProjectStatus.projectId || null;
                
                // Update the existing project tracking to add this mention ID
                await updateProjectStatus(thirdPartyID, existingProjectStatus.status, mentionInfo.tweetId, projectId || undefined);
                
                // We'll continue with checking SpeechLab API to get the latest status
            }
        }
        
        // Check with SpeechLab API regardless
        logger.info(`[⚙️ Backend] Checking for existing SpeechLab project with thirdPartyID: ${thirdPartyID}...`);
        const existingProject = await getProjectByThirdPartyID(thirdPartyID);

        if (existingProject) {
            logger.info(`[⚙️ Backend] ✅ Found existing project with ID: ${existingProject.id} (Status: ${existingProject.job?.status || 'UNKNOWN'}). Reusing this project.`);
            projectId = existingProject.id;
            
            // Update our local tracking with the actual project status
            const apiStatus = existingProject.job?.status || 'UNKNOWN';
            let localStatus: 'initiated' | 'processing' | 'complete' | 'failed';
            
            switch (apiStatus) {
                case 'COMPLETE':
                    localStatus = 'complete';
                    break;
                case 'FAILED':
                    localStatus = 'failed';
                    break;
                case 'PROCESSING':
                case 'QUEUED':
                    localStatus = 'processing';
                    break;
                default:
                    localStatus = 'initiated';
            }
            
            await updateProjectStatus(thirdPartyID, localStatus, mentionInfo.tweetId, projectId);
            
            // If project is already complete, we can skip waiting
            if (apiStatus === 'COMPLETE') {
                logger.info(`[⚙️ Backend] Project is already complete according to SpeechLab API.`);
                // Skip to sharing link generation
            } else if (apiStatus === 'FAILED') {
                // If project has failed, throw an error
                throw new Error(`SpeechLab project ${thirdPartyID} failed to process according to API`);
            } else {
                // For any other status, continue with waiting for completion
                logger.info(`[⚙️ Backend] Project is still processing. Will wait for completion.`);
            }
        } else {
            logger.info(`[⚙️ Backend] No existing project found. Creating a new SpeechLab project...`);
            // Mark as initiated in our tracking system
            await updateProjectStatus(thirdPartyID, 'initiated', mentionInfo.tweetId);
            
            logger.info(`[⚙️ Backend] Creating SpeechLab project: Name="${projectName}", Source=${sourceLanguageCode}, Target=${targetLanguageCode}, 3rdPartyID=${thirdPartyID}`);
            projectId = await createDubbingProject(
                audioUploadResult, 
                projectName, 
                targetLanguageCode, 
                thirdPartyID,
                sourceLanguageCode // Added source language code parameter
            );
            if (!projectId) {
                // Update status to failed
                await updateProjectStatus(thirdPartyID, 'failed', mentionInfo.tweetId);
                throw new Error('Failed to create SpeechLab project after check');
            }
            logger.info(`[⚙️ Backend] New SpeechLab project created: ${projectId} (using thirdPartyID: ${thirdPartyID})`);
            
            // Update our tracking with the new project ID and status
            await updateProjectStatus(thirdPartyID, 'processing', mentionInfo.tweetId, projectId);
        }
        // --- END MODIFIED SECTION ---

        // Ensure we have a project ID before proceeding
        if (!projectId) {
            // Update status to failed
            await updateProjectStatus(thirdPartyID, 'failed', mentionInfo.tweetId);
            throw new Error('Could not determine SpeechLab project ID (existing or new).');
        }

        // 3. Wait for project completion (using the determined projectId and thirdPartyID)
        logger.info(`[⚙️ Backend] Waiting up to 6 hours for SpeechLab project completion (thirdPartyID: ${thirdPartyID})...`);
        const maxWaitTimeMs = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
        // Pass thirdPartyID to wait function, as it uses that for polling
        const completedProject = await waitForProjectCompletion(thirdPartyID, maxWaitTimeMs); 
        if (!completedProject || completedProject.job?.status !== 'COMPLETE') {
            const finalStatus = completedProject?.job?.status || 'TIMEOUT';
            // Update our tracking with failed status
            await updateProjectStatus(thirdPartyID, 'failed', mentionInfo.tweetId, projectId);
            throw new Error(`SpeechLab project ${thirdPartyID} did not complete successfully (Status: ${finalStatus})`);
        }
        
        // Update our tracking with completed status
        await updateProjectStatus(thirdPartyID, 'complete', mentionInfo.tweetId, projectId);
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
            type: 'dubbing', 
            success: true, 
            sharingLink: sharingLink || undefined, 
            publicMp3Url: publicMp3Url, // Will be undefined if download or S3 upload failed
            projectId: projectId,
            thirdPartyID: thirdPartyID
        };

    } catch (error: any) {
        logger.error(`[⚙️ Backend] Error during backend processing for ${spaceId}:`, error);
        // Ensure temporary downloaded audio is cleaned up on error
        if (downloadedAudioPath) {
             logger.info(`[⚙️ Backend] Cleaning up temporary audio file due to error: ${downloadedAudioPath}`);
             await fs.unlink(downloadedAudioPath).catch(()=>{}); // Best effort cleanup
        }
        return { 
            type: 'dubbing', 
            success: false, 
            error: error.message || 'Unknown backend error', 
            thirdPartyID: thirdPartyID 
        };
    }
}

// --- NEW: performSummarizationWorkflow ---
async function performSummarizationWorkflow(initData: InitiationResult): Promise<BackendResult> {
    const { m3u8Url, spaceId, spaceTitle, mentionInfo, sourceLanguageCode } = initData;
    const operationType = 'summarization';
    // Create a unique thirdPartyID for this summarization task
    const summarizationThirdPartyID = `summary-${spaceId}-${mentionInfo.tweetId.substring(0,8)}-${uuidv4().substring(0,8)}`;

    logger.info(`[✍️ Summarize Workflow] Starting for Space ID: ${spaceId}, Mention: ${mentionInfo.tweetId}, 3rdPartyID: ${summarizationThirdPartyID}`);

    let preparedAudio: PreparedAudioInfo | null = null;
    let transcriptionProjectId: string | null = null;

    try {
        // 1. Prepare audio (download, get duration, upload to S3 for transcription)
        logger.info(`[✍️ Summarize Workflow] Preparing audio for transcription (3rdPartyID: ${summarizationThirdPartyID})...`);
        preparedAudio = await prepareAudioForTranscription(m3u8Url, summarizationThirdPartyID); // nameHint can be thirdPartyID
        if (!preparedAudio) {
            throw new Error('Failed to prepare audio for transcription.');
        }
        logger.info(`[✍️ Summarize Workflow] Audio prepared. S3 Key: ${preparedAudio.fileKey}, Duration: ${preparedAudio.duration}s`);

        // 2. Create transcription project with SpeechLab
        const projectName = spaceTitle ? `Summary of ${spaceTitle.substring(0,50)}` : `Summary for Space ${spaceId}`;
        const transcriptionPayload: CreateProjectAndTranscribePayload = {
            fileUuid: preparedAudio.fileUuid,
            fileKey: preparedAudio.fileKey,
            name: projectName.substring(0, 100),
            filenameToReturn: path.basename(preparedAudio.localPath), // e.g., uuid.mp3
            language: sourceLanguageCode, // Source language of the Space
            contentDuration: preparedAudio.duration,
            // thumbnail: undefined, // Optional
            unitType: 'whiteGlove',
            thirdPartyID: summarizationThirdPartyID,
            collectionRef: config.SPEECHLAB_API_COLLECTION_REF_TRANSCRIBE, 
        };

        logger.info(`[✍️ Summarize Workflow] Creating SpeechLab transcription project (3rdPartyID: ${summarizationThirdPartyID})...`);
        await updateProjectStatus(summarizationThirdPartyID, 'initiated', mentionInfo.tweetId, undefined, operationType);
        transcriptionProjectId = await createProjectAndTranscribe(transcriptionPayload);
        if (!transcriptionProjectId) {
            throw new Error('Failed to create SpeechLab transcription project.');
        }
        logger.info(`[✍️ Summarize Workflow] Transcription project created. SpeechLab ID: ${transcriptionProjectId}, 3rdPartyID: ${summarizationThirdPartyID}`);
        await updateProjectStatus(summarizationThirdPartyID, 'transcribing', mentionInfo.tweetId, transcriptionProjectId, operationType);

        // 3. Wait for transcription completion
        logger.info(`[✍️ Summarize Workflow] Waiting for transcription completion (3rdPartyID: ${summarizationThirdPartyID})...`);
        const completedTranscriptionProject = await waitForTranscriptionCompletion(summarizationThirdPartyID);

        if (!completedTranscriptionProject || completedTranscriptionProject.job?.status !== 'COMPLETE') {
            const finalStatus = completedTranscriptionProject?.job?.status || 'TIMEOUT';
            throw new Error(`Transcription project ${summarizationThirdPartyID} did not complete successfully (Status: ${finalStatus})`);
        }
        const transcriptionText = completedTranscriptionProject.transcription?.transcriptionText;
        if (!transcriptionText) {
            throw new Error(`Transcription project ${summarizationThirdPartyID} completed but no transcription text was found.`);
        }
        logger.info(`[✍️ Summarize Workflow] Transcription completed for ${summarizationThirdPartyID}. Text length: ${transcriptionText.length}`);
        await updateProjectStatus(summarizationThirdPartyID, 'summarizing', mentionInfo.tweetId, transcriptionProjectId, operationType);

        // 4. Summarize text with OpenAI
        logger.info(`[✍️ Summarize Workflow] Summarizing transcribed text (3rdPartyID: ${summarizationThirdPartyID})...`);
        const summaryText = await summarizeText(transcriptionText);
        if (!summaryText) {
            throw new Error('Failed to summarize text using OpenAI.');
        }
        logger.info(`[✍️ Summarize Workflow] Summarization successful for ${summarizationThirdPartyID}. Summary length: ${summaryText.length}`);
        await updateProjectStatus(summarizationThirdPartyID, 'complete_summary', mentionInfo.tweetId, transcriptionProjectId, operationType);

        // 5. Clean up local audio file from transcription prep
        if (preparedAudio?.localPath) {
            logger.info(`[✍️ Summarize Workflow] Cleaning up temporary audio file: ${preparedAudio.localPath}`);
            await fsExtra.remove(preparedAudio.localPath)
                .catch(err => logger.warn(`[✍️ Summarize Workflow] Failed to delete temp audio file ${preparedAudio?.localPath}:`, err));
        }

        return {
            type: 'summarization',
            success: true,
            summaryText,
            originalTweetUrl: mentionInfo.tweetUrl,
            projectId: transcriptionProjectId,
            thirdPartyID: summarizationThirdPartyID,
        };

    } catch (error: any) {
        logger.error(`[✍️ Summarize Workflow] Error during summarization for ${summarizationThirdPartyID}:`, error);
        // Determine status based on where the error occurred
        let failureStatus: ProjectStatusInfo['status'] = 'failed';
        if (!transcriptionProjectId) failureStatus = 'failed'; // Failed before or during transcription project creation
        else if (!completedTranscriptionProject || completedTranscriptionProject.job?.status !== 'COMPLETE') failureStatus = 'failed_transcription';
        else if (!summaryText) failureStatus = 'failed_summarization'; // summaryText is scoped, so this is a bit of a guess
        
        await updateProjectStatus(summarizationThirdPartyID, failureStatus, mentionInfo.tweetId, transcriptionProjectId || undefined, operationType);
        
        // Cleanup audio if it was prepared
        if (preparedAudio?.localPath) {
            logger.info(`[✍️ Summarize Workflow] Cleaning up temporary audio file after error: ${preparedAudio.localPath}`);
            await fsExtra.remove(preparedAudio.localPath)
                .catch(err => logger.warn(`[✍️ Summarize Workflow] Failed to delete temp audio file ${preparedAudio?.localPath} after error:`, err));
        }
        return { 
            type: 'summarization', 
            success: false, 
            error: error.message || 'Unknown summarization workflow error', 
            thirdPartyID: summarizationThirdPartyID,
            projectId: transcriptionProjectId,
            originalTweetUrl: mentionInfo.tweetUrl, // Include for error reply context
        };
    }
}
// --- END performSummarizationWorkflow ---

// --- Queues & Workers --- 
/**
 * Adds a completed backend job to the final reply queue and triggers the worker.
 */
function addToFinalReplyQueue(mentionInfo: MentionInfo, backendResult: BackendResult) {
    logger.info(`[↩️ Reply Queue] Adding result for ${mentionInfo.tweetId} to reply queue. Type: ${backendResult.type}, Success: ${backendResult.success}`);
    finalReplyQueue.push({ mentionInfo, backendResult });
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
    
    // --- Enhanced Queue Logging ---
    const queuePreview = mentionQueue.slice(0, 5).map(m => `${m.tweetId} (${m.username})`).join(', ');
    const remainingCount = Math.max(0, mentionQueue.length - 5);
    logger.info(`[🚀 Initiate Queue] Starting worker. Queue size: ${mentionQueue.length}. Next 5 mentions: [${queuePreview}]${remainingCount > 0 ? ` and ${remainingCount} more...` : ''}`);
    // --- End Enhanced Logging ---

    const mentionToProcess = mentionQueue.shift(); 
    if (!mentionToProcess) {
        isInitiatingProcessing = false;
        logger.warn('[🚀 Initiate Queue] Worker started but queue was empty.');
        return; // Should not happen, but safety check
    }

    processedCount++; // Increment processed count for stats
    logger.info(`[🚀 Initiate Queue] Processing mention ${mentionToProcess.tweetId} (${mentionToProcess.username}). Remaining: ${mentionQueue.length}. This is mention #${processedCount} processed since startup.`);
    
    try {
        // Perform browser initiation steps
        const initData = await initiateProcessing(mentionToProcess, page);
        
        if (!initData) {
            // Error already posted by initiateProcessing, or it was a non-recoverable error (e.g., no M3U8)
            logger.error(`[🚀 Initiate Queue] Initiation failed for ${mentionToProcess.tweetId}, no M3U8 or playable element. Marking as processed.`);
            await logMentionError(mentionToProcess.tweetId, 'Initiation failed to find M3U8/playable element', 'initiation');
            // Note: markMentionAsProcessed is called by logMentionError
            isInitiatingProcessing = false;
            return;
        }

        // Branch based on processing type
        if (initData.processingType === 'summarization') {
            logger.info(`[🚀 Initiate Queue] Handing off ${mentionToProcess.tweetId} to Summarization Workflow.`);
            performSummarizationWorkflow(initData)
                .then(backendResult => addToFinalReplyQueue(mentionToProcess, backendResult))
                .catch(error => {
                    logger.error(`[💥 Summarize Workflow ERROR] Uncaught: ${mentionToProcess.tweetId}:`, error);
                    addToFinalReplyQueue(mentionToProcess, { type: 'summarization', success: false, error: 'Summarization workflow failed unexpectedly', originalTweetUrl: mentionToProcess.tweetUrl });
                    logMentionError(mentionToProcess.tweetId, error, 'backend'); // Use generic backend phase for this catch-all
                });
        } else { // Default to dubbing
            logger.info(`[🚀 Initiate Queue] Handing off ${mentionToProcess.tweetId} to Dubbing Backend.`);
            performBackendProcessing(initData) // Existing dubbing logic
                .then(backendResult => addToFinalReplyQueue(mentionToProcess, backendResult))
                .catch(error => {
                    logger.error(`[💥 Dubbing Backend ERROR] Uncaught: ${mentionToProcess.tweetId}:`, error);
                    addToFinalReplyQueue(mentionToProcess, { type: 'dubbing', success: false, error: 'Dubbing backend processing failed unexpectedly' });
                    logMentionError(mentionToProcess.tweetId, error, 'backend');
                });
        }
            
    } catch (initError) {
        logger.error(`[🚀 Initiate Queue] Outer initiation phase error for ${mentionToProcess.tweetId}:`, initError);
        await logMentionError(mentionToProcess.tweetId, initError, 'initiation');
    }

    logger.info(`[🚀 Initiate Queue] Finished triggering backend work for ${mentionToProcess.tweetId}.`);
    isInitiatingProcessing = false; 
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
    logger.info(`[↩️ Reply Queue] Processing final reply for ${mentionInfo.tweetId}. Type: ${backendResult.type}, Backend Success: ${backendResult.success}`);

    let finalMessage = ''; // Keep for potential single message fallback
    // Media attachment is currently disabled by default via config
    let mediaPathToAttach: string | undefined = undefined;

    // Construct the final message based on success and link availability
    if (backendResult.type === 'dubbing') {
        if (backendResult.success) {
            const { sourceLanguageName, targetLanguageName } = detectLanguages(mentionInfo.text);
            const hasSharingLink = !!backendResult.sharingLink;
            const hasMp3Link = !!backendResult.publicMp3Url;
            
            if (hasMp3Link) {
                let linkParts = [`MP3: ${backendResult.publicMp3Url}`];
                if (hasSharingLink) linkParts.push(`Project: ${backendResult.sharingLink}`);
                finalMessage = `@${config.TWITTER_USERNAME} @${mentionInfo.username} Your ${sourceLanguageName} to ${targetLanguageName} dub is ready! $SHAFT 🎉 ${linkParts.join(' | ')}`;
            } else {
                logger.warn(`[↩️ Reply Queue - Dubbing] Backend succeeded for ${mentionInfo.tweetId} but MP3 link is missing.`);
                let partialFailureMessage = `@${mentionInfo.username} Processing finished for the ${sourceLanguageName} to ${targetLanguageName} dub, but I couldn't prepare the MP3 audio file. 😥`;
                if (hasSharingLink) partialFailureMessage += ` You might find project details here: ${backendResult.sharingLink}`;
                if (backendResult.projectId) partialFailureMessage += ` (Project ID: ${backendResult.projectId})`;
                finalMessage = partialFailureMessage;
            }
        } else {
            const { sourceLanguageName, targetLanguageName } = detectLanguages(mentionInfo.text);
            const errorReason = backendResult.error || 'processing failed';
            finalMessage = `@${mentionInfo.username} Oops! 😥 Couldn't complete the ${sourceLanguageName} to ${targetLanguageName} dub for this Space (${errorReason}). Maybe try again later?`;
        }
    } else if (backendResult.type === 'summarization') {
        if (backendResult.success) {
            // Split summary if too long for a single tweet
            const summary = backendResult.summaryText;
            const maxTweetLength = 270; // Max length considering @mentions and links
            const userMention = `@${mentionInfo.username}`;
            const leadText = `${userMention} Here's a summary of the Space: \n\n`;
            const followupLeadText = `${userMention} (cont.) Summary: \n\n`;

            if (leadText.length + summary.length <= maxTweetLength) {
                finalMessage = `${leadText}${summary}`;
            } else {
                // TODO: Implement multi-tweet reply for long summaries.
                // For now, truncate if too long, or consider a different strategy (e.g., link to full summary elsewhere)
                logger.warn(`[↩️ Reply Queue - Summarization] Summary for ${mentionInfo.tweetId} is too long. Truncating.`);
                const availableLength = maxTweetLength - leadText.length - 5; // 5 for " ..."
                finalMessage = `${leadText}${summary.substring(0, availableLength)} ...`;
                // This is a placeholder for a better long-summary handling strategy.
            }
        } else {
            const errorReason = backendResult.error || 'summarization failed';
            finalMessage = `@${mentionInfo.username} Oops! 😥 I couldn't summarize this Space (${errorReason}). Maybe try again later?`;
        }
    }
    
    logger.info(`[↩️ Reply Queue] Final constructed reply text for ${mentionInfo.tweetId}: ${finalMessage}`);

    let postSuccess = false;
    try {
        if (config.USE_TWITTER_API_FOR_REPLY) {
            postSuccess = await postTweetReplyWithMediaApi(finalMessage, mentionInfo.tweetId, mediaPathToAttach);
        } else {
            postSuccess = await postReplyToTweet(page, mentionInfo.tweetUrl, finalMessage, mediaPathToAttach);
        }
        
        if (postSuccess) {
            logger.info(`[↩️ Reply Queue] Successfully posted final reply via ${postMethod} for ${mentionInfo.tweetId}.`);
            // Mark as processed only if backend succeeded OR if it was a summarization failure (to avoid retrying failed summaries)
            // Dubbing failures might be retried if not marked here, but summarization is more deterministic on API side for now.
            if (backendResult.success || backendResult.type === 'summarization') { 
                await markMentionAsProcessed(mentionInfo.tweetId, processedMentions); 
                if (backendResult.thirdPartyID) {
                    const finalStatus = backendResult.success ? (backendResult.type === 'dubbing' ? 'complete' : 'complete_summary') 
                                                        : (backendResult.type === 'dubbing' ? 'failed' : 'failed_summarization'); // or failed_transcription
                    await updateProjectStatus(backendResult.thirdPartyID, finalStatus, mentionInfo.tweetId, backendResult.projectId, backendResult.type);
                }
            } else {
                logger.info(`[↩️ Reply Queue] Dubbing backend failed for ${mentionInfo.tweetId}. Not marking as processed to allow potential retry based on polling logic if applicable.`);
                // For dubbing, we might rely on the existing project status polling to eventually mark as failed if needed.
                // For summarization, we mark failed ones as processed to prevent re-queue of a known bad summary attempt.
                if (backendResult.thirdPartyID) { // Still update status to failed
                     await updateProjectStatus(backendResult.thirdPartyID, 'failed', mentionInfo.tweetId, backendResult.projectId, backendResult.type);
                }
                await logMentionError(mentionInfo.tweetId, backendResult.error || 'Unknown backend error', 'backend');
            }

            // Cleanup for DUBBING success with MP3
            if (backendResult.type === 'dubbing' && backendResult.success && backendResult.publicMp3Url) {
                const tempDubbedPath = path.join(TEMP_AUDIO_DIR, `${backendResult.thirdPartyID}_dubbed.mp3`);
                await fsExtra.remove(tempDubbedPath)
                    .then(() => logger.info(`[↩️ Reply Queue] Cleaned up temp dubbed MP3: ${tempDubbedPath}`))
                    .catch(err => logger.warn(`[↩️ Reply Queue] Failed to delete temp dubbed MP3 ${tempDubbedPath}:`, err));
            }
        } else {
            logger.warn(`[↩️ Reply Queue] Failed to post final reply via ${postMethod} for ${mentionInfo.tweetId}. Will be retried if not marked processed.`);
            // Don't mark as processed if reply fails, so it might be picked up again or handled by error log
            await logMentionError(mentionInfo.tweetId, 'Failed to post reply', 'reply');
        }
    } catch (replyError) {
        logger.error(`[↩️ Reply Queue] CRITICAL: Error posting final ${postMethod} reply for ${mentionInfo.tweetId}:`, replyError);
        await logMentionError(mentionInfo.tweetId, replyError, 'reply');
    } finally {
        logger.info(`[↩️ Reply Queue] Finished ${postMethod} reply work for ${mentionInfo.tweetId}.`);
        isPostingFinalReply = false; 
    }
}

/**
 * Logs a comprehensive summary of current queue status
 */
function logQueueStatus() {
    try {
        // Get info about what's currently processing
        const currentStatus = isInitiatingProcessing ? "BUSY - Processing a mention" : 
                             isPostingFinalReply ? "BUSY - Posting a final reply" : 
                             "IDLE - Ready for next task";
        
        // Count processed mentions since startup
        const processedSoFar = processedCount;
        
        // Get queue previews
        const initQueuePreview = mentionQueue.length > 0 
            ? mentionQueue.slice(0, 3).map(m => `${m.tweetId} (${m.username})`).join(', ')
            : "empty";
            
        const replyQueuePreview = finalReplyQueue.length > 0
            ? finalReplyQueue.slice(0, 3).map(r => `${r.mentionInfo.tweetId} (${r.mentionInfo.username})`).join(', ')
            : "empty";
        
        // Log comprehensive status
        logger.info(`[📊 Queue Status] Browser: ${currentStatus} | Processed: ${processedSoFar} mentions`);
        logger.info(`[📊 Queue Status] Init Queue (${mentionQueue.length}): ${initQueuePreview}${mentionQueue.length > 3 ? ` + ${mentionQueue.length - 3} more` : ''}`);
        logger.info(`[📊 Queue Status] Reply Queue (${finalReplyQueue.length}): ${replyQueuePreview}${finalReplyQueue.length > 3 ? ` + ${finalReplyQueue.length - 3} more` : ''}`);
    } catch (error) {
        logger.error(`[📊 Queue Status] Error generating queue status: ${error}`);
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
    let projectLogIntervalId: NodeJS.Timeout | null = null; // Keep track of project logging interval

    // Graceful shutdown handler
    const shutdown = async (signal: string) => {
        logger.info(`[😈 Daemon] Received ${signal}. Shutting down gracefully...`);
        if (mainLoopIntervalId) clearInterval(mainLoopIntervalId);
        mainLoopIntervalId = null; // Prevent further polling calls
        if (browserTaskIntervalId) clearInterval(browserTaskIntervalId);
        browserTaskIntervalId = null; // Prevent further browser task calls
        if (projectLogIntervalId) clearInterval(projectLogIntervalId);
        projectLogIntervalId = null; // Prevent further project logging

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
        
        // Log active projects at startup
        logger.info('[😈 Daemon] Logging active projects at startup:');
        await logActiveProjects();
        
        // Set up periodic project logging (every 30 minutes)
        const PROJECT_LOG_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
        logger.info(`[😈 Daemon] Setting up periodic project logging (every ${PROJECT_LOG_INTERVAL_MS/60000} minutes)`);
        projectLogIntervalId = setInterval(async () => {
            logger.info('[😈 Daemon] Periodic active project log:');
            await logActiveProjects();
        }, PROJECT_LOG_INTERVAL_MS);

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

        const skipInitialMentions = process.env.SKIP_INITIAL_MENTIONS === 'true'; // Check environment variable

        // --- Main Polling Loop Setup ---
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
                let newMentionsFound = 0;
                
                // Log count of already processed mentions for visibility
                const alreadyProcessedCount = mentions.filter(m => processedMentions.has(m.tweetId)).length;
                if (alreadyProcessedCount > 0) {
                    logger.info(`[😈 Daemon Polling] Found ${alreadyProcessedCount} already processed mentions (skipping).`);
                }
                
                // Create a preview of new mentions being added
                const newMentions: MentionInfo[] = [];
                // Track mentions we've seen in this batch to avoid duplicates in the same poll
                const seenInThisBatch = new Set<string>();
                // Check current queue IDs to avoid adding duplicates
                const currentQueueIds = new Set(mentionQueue.map(m => m.tweetId));
                
                for (const mention of mentions) {
                    // Skip if already in processed set, already in the current queue, or already seen in this batch
                    if (processedMentions.has(mention.tweetId) || 
                        currentQueueIds.has(mention.tweetId) || 
                        seenInThisBatch.has(mention.tweetId)) {
                        continue;
                    }
                    
                    // Mark as seen in this batch
                    seenInThisBatch.add(mention.tweetId);
                    
                    // Then check if it's associated with a project
                    const associatedProject = await getProjectForMention(mention.tweetId);
                    
                    if (associatedProject) {
                        logger.info(`[🔔 Mention] Found mention ID=${mention.tweetId} already associated with project ${associatedProject.thirdPartyID} (status: ${associatedProject.status})`);
                        
                        // If project is already completed or failed, mark the mention as processed
                        if (associatedProject.status === 'complete' || associatedProject.status === 'failed') {
                            logger.info(`[🔔 Mention] Project ${associatedProject.thirdPartyID} is already ${associatedProject.status}. Marking mention as processed.`);
                            await markMentionAsProcessed(mention.tweetId, processedMentions);
                        } else {
                            // Project is still in progress, don't add to queue but log the state
                            logger.info(`[🔔 Mention] Project ${associatedProject.thirdPartyID} is still ${associatedProject.status}. Not queuing duplicate mention.`);
                        }
                    } else {
                        // No associated project found, process as new mention
                        newMentionsFound++;
                        logger.info(`[🔔 Mention] Found new unprocessed mention: ID=${mention.tweetId}, User=${mention.username}, Text="${mention.text?.substring(0, 50)}${mention.text?.length > 50 ? '...' : ''}"`);
                        mentionQueue.push(mention);
                        newMentions.push(mention);
                        logger.info(`[⚙️ Queue] Mention ${mention.tweetId} added to initiation queue. Queue size: ${mentionQueue.length}`);
                    }
                }
                
                if (newMentionsFound > 0) {
                    // Generate a summary of newly added mentions
                    const mentionSummary = newMentions.map(m => 
                        `${m.tweetId} (${m.username}): "${m.text?.substring(0, 30)}${m.text?.length > 30 ? '...' : ''}"`
                    ).join('\n  - ');
                    
                    logger.info(`[😈 Daemon Polling] Added ${newMentionsFound} new mentions to the queue:\n  - ${mentionSummary}`);
                    
                    // Log comprehensive queue status after adding new mentions
                    logQueueStatus();
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

        if (skipInitialMentions) {
            logger.warn(`[😈 Daemon] SKIP_INITIAL_MENTIONS flag is set. Performing initial scrape to mark mentions as processed WITHOUT queueing...`);
            try {
                if (!page || page.isClosed()) {
                    throw new Error("Page closed before initial skip scrape could run.");
                }
                // Scrape mentions once
                const initialMentions = await scrapeMentions(page);
                logger.info(`[😈 Daemon] Initial scrape found ${initialMentions.length} mentions.`);
                let skippedCount = 0;
                for (const mention of initialMentions) {
                    // Check if it's *not* already processed, just in case
                    if (!processedMentions.has(mention.tweetId)) {
                        // For initial skipping, we'll mark as processed but also create a placeholder project entry
                        // to indicate that this mention was intentionally skipped
                        logger.info(`[😈 Daemon] Marking initially found mention ${mention.tweetId} as processed (skipping queue).`);
                        
                        // Create a placeholder thirdPartyID for the skipped mention
                        const placeholderThirdPartyID = `skipped-${mention.tweetId}`;
                        
                        // Mark the mention as processed
                        await markMentionAsProcessed(mention.tweetId, processedMentions);
                        
                        // Create a placeholder project entry with 'complete' status to prevent future processing
                        await updateProjectStatus(
                            placeholderThirdPartyID,
                            'complete',  // Mark as complete to avoid reprocessing
                            mention.tweetId,
                            undefined    // No actual project ID since this was skipped
                        );
                        
                        skippedCount++;
                    } else {
                         logger.debug(`[😈 Daemon] Initially found mention ${mention.tweetId} was already marked as processed.`);
                    }
                }
                logger.info(`[😈 Daemon] Finished marking ${skippedCount} initial mentions as processed.`);

                // Now, just start the interval WITHOUT the initial poll call
                logger.info(`[😈 Daemon] Starting regular mention polling loop (Interval: ${POLLING_INTERVAL_MS / 1000}s) after initial skip.`);
                mainLoopIntervalId = setInterval(pollMentions, POLLING_INTERVAL_MS);

            } catch (error) {
                logger.error('[😈 Daemon] Error during initial mention skip scrape:', error);
                logger.error('[😈 Daemon] Proceeding to normal polling interval, but backlog may not have been skipped.');
                // Fallback: Start interval without initial poll on error during skip attempt
                mainLoopIntervalId = setInterval(pollMentions, POLLING_INTERVAL_MS);
            }
        } else {
            // --- Original Behavior: Initial poll, then set interval ---
            logger.info(`[😈 Daemon] Starting mention polling loop (Interval: ${POLLING_INTERVAL_MS / 1000}s)`);
            await pollMentions(); // Perform the first poll immediately (adds to queue)
            mainLoopIntervalId = setInterval(pollMentions, POLLING_INTERVAL_MS); // Then set the interval
        }

        // --- Browser Task Worker Loop ---
        // Separate interval to trigger browser-based queue workers (initiation & final reply)
        // This ensures they don't block the main polling loop and manage page access.
        const BROWSER_TASK_INTERVAL_MS = 5000; // Check queues every 5 seconds
        logger.info(`[😈 Daemon] Starting browser task worker loop (Interval: ${BROWSER_TASK_INTERVAL_MS / 1000}s)`);
        
        // Add counter for status reporting
        let taskLoopCounter = 0;
        
        browserTaskIntervalId = setInterval(() => {
            taskLoopCounter++;
            
            // Log queue status every 12 iterations (~ every minute)
            if (taskLoopCounter % 12 === 0) {
                logQueueStatus();
            }
            
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

/**
 * Retrieves project information associated with a specific mention ID.
 * This helps determine if a mention is already being processed as part of a project.
 * @param mentionId The mention ID to check
 * @returns Project status info or null if no associated project found
 */
async function getProjectForMention(mentionId: string): Promise<ProjectStatusInfo | null> {
    try {
        await fs.access(PROCESSED_MENTIONS_PATH);
        const data = await fs.readFile(PROCESSED_MENTIONS_PATH, 'utf-8');
        let mentionData: ProcessedMentionData;
        
        try {
            mentionData = JSON.parse(data);
            
            // If the structure is not valid, return null
            if (!mentionData.projects) {
                return null;
            }
            
            // Check each project to see if it includes this mention ID
            for (const projectId in mentionData.projects) {
                const project = mentionData.projects[projectId];
                if (project.mentionIds && project.mentionIds.includes(mentionId)) {
                    logger.info(`[😈 Daemon] Found project ${projectId} associated with mention ${mentionId}`);
                    return project;
                }
            }
        } catch (parseError) {
            logger.error(`[😈 Daemon] Error parsing processed mentions file while checking mention-project association:`, parseError);
        }
        
        return null;
    } catch (error) {
        logger.error(`[😈 Daemon] Error checking project for mention ${mentionId}:`, error);
        return null;
    }
}

/**
 * Helper function to log all active projects (for debugging)
 */
async function logActiveProjects(): Promise<void> {
    try {
        await fs.access(PROCESSED_MENTIONS_PATH);
        const data = await fs.readFile(PROCESSED_MENTIONS_PATH, 'utf-8');
        let mentionData: ProcessedMentionData;
        
        try {
            mentionData = JSON.parse(data);
            
            if (!mentionData.projects || Object.keys(mentionData.projects).length === 0) {
                logger.info(`[😈 Daemon] No active projects found.`);
                return;
            }
            
            logger.info(`[😈 Daemon] === Current Projects (${Object.keys(mentionData.projects).length}) ===`);
            
            for (const thirdPartyID in mentionData.projects) {
                const project = mentionData.projects[thirdPartyID];
                logger.info(`[😈 Daemon] Project: ${thirdPartyID}`);
                logger.info(`[😈 Daemon]   - Status: ${project.status}`);
                logger.info(`[😈 Daemon]   - SpeechLab ID: ${project.projectId || 'N/A'}`);
                logger.info(`[😈 Daemon]   - Created: ${project.createdAt}`);
                logger.info(`[😈 Daemon]   - Updated: ${project.updatedAt}`);
                logger.info(`[😈 Daemon]   - Associated Mentions: ${project.mentionIds.length}`);
                logger.info(`[😈 Daemon]   - Mention IDs: ${project.mentionIds.join(', ')}`);
            }
            
            logger.info(`[😈 Daemon] === End Projects ===`);
        } catch (parseError) {
            logger.error(`[😈 Daemon] Error parsing processed mentions file while logging active projects:`, parseError);
        }
    } catch (error) {
        logger.error(`[😈 Daemon] Error reading file for logging active projects:`, error);
    }
}

main(); 