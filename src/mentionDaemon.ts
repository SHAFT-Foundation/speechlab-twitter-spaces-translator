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
    extractSpaceTitleFromModal,
    getVideoM3u8FromMention
} from './services/twitterInteractionService';
import { downloadAndUploadAudio, downloadAndUploadVideo } from './services/audioService';
import { createDubbingProject, waitForProjectCompletion, generateSharingLink, getProjectByThirdPartyID } from './services/speechlabApiService';
import { detectLanguage, detectLanguages, getLanguageName } from './utils/languageUtils';
import { v4 as uuidv4 } from 'uuid';
import { downloadFile } from './utils/fileUtils';
import { mergeVideoDubbedAudio, extractAudioFromVideo } from './utils/videoUtils';
import { exec } from 'child_process';
import util from 'util';
import { postTweetReplyWithMediaApi } from './services/twitterApiService';
import { uploadLocalFileToS3 } from './services/audioService';
import * as fsExtra from 'fs-extra';
import { initSupabase, upsertMention, updateMentionStatus, getAllProcessedMentions, getMention } from './services/supabaseService';

const execPromise = util.promisify(exec);

// --- Queues & Workers Data Structures ---
const mentionQueue: MentionInfo[] = []; // Queue for incoming mentions
const finalReplyQueue: { mentionInfo: MentionInfo, backendResult: BackendResult }[] = []; // Queue for final replies
let isInitiatingProcessing = false; // Flag for browser task (initiation)
let isPostingFinalReply = false;   // Flag for browser task (final reply)

// Track mentions currently being processed (not yet replied to)
const inProgressMentions: Set<string> = new Set();

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
}
// Interface for backend result
interface BackendResult {
    success: boolean;
    sharingLink?: string;   // Link to SpeechLab project page
    publicMp3Url?: string;  // Link to the uploaded dubbed MP3 on S3
    publicVideoUrl?: string; // Link to the uploaded dubbed video on S3 (NEW)
    projectId?: string;
    thirdPartyID?: string;  // Added thirdPartyID to track in processed mentions
    error?: string;
}

// New interfaces for processed mentions tracking
interface ProcessedMentionData {
    mentions: string[];
    projects: Record<string, ProjectStatusInfo>;
}

interface ProjectStatusInfo {
    thirdPartyID: string;
    projectId?: string;
    status: 'initiated' | 'processing' | 'complete' | 'failed';
    createdAt: string;
    updatedAt: string;
    mentionIds: string[];
}

const PROCESSED_MENTIONS_PATH = path.join(process.cwd(), 'processed_mentions.json');
const POLLING_INTERVAL_MS = 60 * 1000; // Check every 60 seconds (1 minute) for testing
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
    status: 'initiated' | 'processing' | 'complete' | 'failed',
    mentionId: string,
    projectId?: string
): Promise<void> {
    logger.info(`[😈 Daemon] Updating project status: thirdPartyID=${thirdPartyID}, projectId=${projectId || 'N/A'}, status=${status}, mentionId=${mentionId}`);
    
    try {
        // Load current data
        await fs.access(PROCESSED_MENTIONS_PATH);
        const data = await fs.readFile(PROCESSED_MENTIONS_PATH, 'utf-8');
        let mentionData: ProcessedMentionData;
        
        try {
            mentionData = JSON.parse(data);
            // Ensure proper structure
            if (!mentionData.projects) {
                mentionData.projects = {};
            }
            if (!mentionData.mentions) {
                mentionData.mentions = [];
            }
        } catch (parseError) {
            mentionData = { mentions: [], projects: {} };
        }
        
        const now = new Date().toISOString();
        
        // Update or create project status entry
        if (mentionData.projects[thirdPartyID]) {
            // Update existing project
            const project = mentionData.projects[thirdPartyID];
            // Log previous status if it's changing
            if (project.status !== status) {
                logger.info(`[😈 Daemon] Project ${thirdPartyID} status changing: ${project.status} → ${status}`);
            }
            project.status = status;
            project.updatedAt = now;
            
            // Add projectId if provided and not already set
            if (projectId && !project.projectId) {
                logger.info(`[😈 Daemon] Adding SpeechLab projectId ${projectId} to project ${thirdPartyID}`);
                project.projectId = projectId;
            }
            
            // Add mentionId if not already in the list
            if (!project.mentionIds.includes(mentionId)) {
                logger.info(`[😈 Daemon] Adding mention ${mentionId} to project ${thirdPartyID}`);
                project.mentionIds.push(mentionId);
            }
        } else {
            // Create new project entry
            logger.info(`[😈 Daemon] Creating new project tracking entry: thirdPartyID=${thirdPartyID}, status=${status}`);
            mentionData.projects[thirdPartyID] = {
                thirdPartyID,
                projectId,
                status,
                createdAt: now,
                updatedAt: now,
                mentionIds: [mentionId]
            };
        }
        
        await fs.writeFile(PROCESSED_MENTIONS_PATH, JSON.stringify(mentionData, null, 2));
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
async function initiateProcessing(mentionInfo: MentionInfo, page: Page): Promise<InitiationResult> {
    logger.info(`[🚀 Initiate] Starting browser phase for ${mentionInfo.tweetId}`);
    // Rename variable to reflect it might be article OR button
    let playElementLocator: Locator | null = null;

    // Detect source and target languages
    const { sourceLanguageCode, sourceLanguageName, targetLanguageCode, targetLanguageName } = detectLanguages(mentionInfo.text);
    logger.info(`[🚀 Initiate] Detected languages: Source: ${sourceLanguageName} (${sourceLanguageCode}), Target: ${targetLanguageName} (${targetLanguageCode})`);

    // Check if video processing is enabled and if mention contains a Space URL or video
    const spaceUrl = extractSpaceUrl(mentionInfo.text);

    // NEW: Check for video if no Space URL found and video processing is enabled
    if (!spaceUrl && config.PROCESS_VIDEO_IN_MENTIONS) {
        logger.info(`[🎬 Initiate] No Space URL found. Checking for video in mention...`);
        try {
            const { videoM3u8Url, hasVideo } = await getVideoM3u8FromMention(page, mentionInfo.tweetUrl);

            if (hasVideo && videoM3u8Url) {
                logger.info(`[🎬 Initiate] ✅ Found video in mention with M3U8 URL: ${videoM3u8Url}`);
                // Store video info in mentionInfo for backend processing
                mentionInfo.hasVideo = true;
                mentionInfo.videoM3u8Url = videoM3u8Url;

                // Extract pseudo space ID from video URL or use tweet ID
                const spaceId = videoM3u8Url.match(/([a-zA-Z0-9_-]+)\/(?:chunk|playlist)/)?.[1] || `video_${mentionInfo.tweetId}`;
                const spaceTitle = `Video from @${mentionInfo.username}`;

                // Post acknowledgement reply
                try {
                    logger.info(`[🎬 Initiate] Posting preliminary acknowledgement reply for video...`);
                    const ackMessage = `${mentionInfo.username} Received! I've started processing this video from ${sourceLanguageName} to ${targetLanguageName}. Please check back here in ~10-15 minutes for the dubbed video.`;
                    logger.info(`[🎬 Initiate] Full Ack Reply Text: ${ackMessage}`);
                    const ackSuccess = await postReplyToTweet(page, mentionInfo.tweetUrl, ackMessage);
                    if (!ackSuccess) {
                        logger.warn(`[🎬 Initiate] Failed to post acknowledgement reply (non-critical).`);
                    }
                } catch (ackError) {
                    logger.warn(`[🎬 Initiate] Error posting acknowledgement reply (non-critical):`, ackError);
                }

                // Return initiation result for video processing
                logger.info(`[🎬 Initiate] Video initiation complete for ${mentionInfo.tweetId}. Returning data.`);
                return {
                    m3u8Url: videoM3u8Url,
                    spaceId,
                    spaceTitle,
                    mentionInfo,
                    sourceLanguageCode,
                    sourceLanguageName,
                    targetLanguageCode,
                    targetLanguageName,
                };
            } else if (hasVideo && !videoM3u8Url) {
                logger.warn(`[🎬 Initiate] Video detected but M3U8 URL could not be captured.`);
                const errorReplyText = `${mentionInfo.username} Sorry, I found a video but couldn't extract the stream URL. The video might be protected or not yet available.`;
                logger.info(`[🎬 Initiate] Posting error reply: ${errorReplyText}`);
                await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
                throw new Error('Video detected but M3U8 extraction failed');
            } else {
                logger.info(`[🎬 Initiate] No video found in mention. Will try Space detection next.`);
                // Don't throw - let it fall through to Space detection
            }
        } catch (videoError) {
            logger.error(`[🎬 Initiate] Error during video detection:`, videoError);
            // If error was thrown with a message, it already posted a reply - don't continue to Space detection
            if (videoError instanceof Error && videoError.message.includes('M3U8 extraction failed')) {
                throw videoError; // Stop here, error reply already posted
            }
            // Otherwise, log and continue to Space detection as fallback
            logger.info(`[🎬 Initiate] Continuing to Space detection after video error.`);
        }
    }

    // 1. Navigate & Find Article (for Twitter Spaces)
    try {
        logger.info(`[🚀 Initiate] Navigating to mention tweet: ${mentionInfo.tweetUrl}`);
        await page.goto(mentionInfo.tweetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
        logger.info('[🚀 Initiate] Waiting 60 seconds after navigation...');
        await page.waitForTimeout(60000);

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

            // Check if this was a text-only mention (no video, no Space)
            if (!spaceUrl && config.PROCESS_VIDEO_IN_MENTIONS) {
                // This was a text-only mention with no content to process
                const errorReplyText = `${mentionInfo.username} To dub content, please:\n1. Attach a video to your mention, OR\n2. Include a Twitter Space URL in your tweet\n\nExample: "@DubbingAgent [video attached] dub to German"`;
                logger.info(`[🚀 Initiate] Posting helpful error reply for text-only mention: ${errorReplyText}`);
                await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
            } else {
                // Normal Space not found error
                const errorReplyText = `${mentionInfo.username} Sorry, I couldn't find a playable Twitter Space associated with this tweet.`;
                logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
                await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
            }
            throw new Error(errMsg); // Throw to signal failure
        }
        logger.info(`[🚀 Initiate] Found potential Space element (article or button).`);

    } catch (error) {
        logger.error(`[🚀 Initiate] Error during navigation/article finding for ${mentionInfo.tweetId}:`, error);
        // Try to post error reply if possible (and if it wasn't the error above)
        if (!(error instanceof Error && error.message.includes('Playable Space article not found'))) {
            try {
                 // --- ADDED: Log error reply before sending ---
                 const errorReplyText = `${mentionInfo.username} Sorry, I had trouble loading the tweet to find the Space.`;
                 logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
                 // --- END ADDED SECTION ---
                 await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
            } catch (replyError) { /* Ignore */ }
        }
        throw error; // Re-throw original error
    }
    
    // 2. Extract Title from Article (First attempt, before clicking Play)
    let spaceTitle: string | null = null;
    try {
        logger.debug(`[🚀 Initiate] Attempting to extract Space title from located element (pre-click)...`);
        
        // Strategy 1: Check aria-label of the button first
        let parsedFromAriaLabel = false;
        try {
            const tagName = await playElementLocator.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
            if (tagName === 'button') {
                const ariaLabel = await playElementLocator.getAttribute('aria-label');
                const prefix = 'Play recording of ';
                if (ariaLabel && ariaLabel.startsWith(prefix)) {
                    const potentialTitle = ariaLabel.substring(prefix.length).trim();
                    if (potentialTitle && potentialTitle.length > 0) {
                        spaceTitle = potentialTitle.substring(0, 150); // Allow slightly longer title from aria-label
                        logger.info(`[🚀 Initiate] Extracted title from button aria-label: "${spaceTitle}"`);
                        parsedFromAriaLabel = true;
                    }
                }
            }
        } catch (ariaError) {
             logger.warn('[🚀 Initiate] Minor error checking button aria-label for title:', ariaError);
        }
        
        // Strategy 2: If not found in aria-label, check the main tweet text associated with the element
        if (!parsedFromAriaLabel) {
            logger.debug(`[🚀 Initiate] Trying title extraction from associated tweet text (data-testid="tweetText")...`);
             try {
                 // Find the tweetText div relative to the play element locator
                 const tweetTextElement = playElementLocator.locator('div[data-testid="tweetText"]').first();
                 // Alternative: Find closest ancestor article first, then the tweetText within it
                 // const ancestorArticle = playElementLocator.locator('xpath=ancestor::article[1]').first();
                 // const tweetTextElement = ancestorArticle.locator('div[data-testid="tweetText"]').first();
                 
                 if (await tweetTextElement.isVisible({ timeout: 1000 })) {
                     const potentialTitle = await tweetTextElement.textContent({ timeout: 1000 });
                     if (potentialTitle && potentialTitle.trim().length > 3) {
                         // Basic cleaning - remove the @mention part if it exists at the start
                         const cleanedTitle = potentialTitle.trim().replace(/^@[^\s]+\s*/, ''); 
                         spaceTitle = cleanedTitle.substring(0, 150); // Limit length
                         logger.info(`[🚀 Initiate] Extracted title from associated tweet text: "${spaceTitle}"`);
                     } else {
                         logger.debug('[🚀 Initiate] tweetText element found, but content too short or empty.');
                     }
                 } else {
                     logger.debug('[🚀 Initiate] Could not find visible tweetText element associated with play element.');
                 }
            } catch (tweetTextError) {
                logger.warn('[🚀 Initiate] Error trying to extract title from associated tweet text:', tweetTextError);
            }
        }

        // Log if still not found pre-click (will rely on modal extraction)
        if (!spaceTitle) {
             logger.info('[🚀 Initiate] Could not extract Space title from element pre-click (checked aria-label and tweetText). Will rely on modal extraction later.');
        }

    } catch (titleError) {
        logger.warn('[🚀 Initiate] Error during pre-click title extraction:', titleError);
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
            // --- ADDED: Log error reply before sending ---
            const errorReplyText = `${mentionInfo.username} Sorry, I could find the Space but couldn't get its audio stream. It might be finished or protected.`;
            logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
            // --- END ADDED SECTION ---
            await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
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
             // --- ADDED: Log error reply before sending ---
             const errorReplyText = `${mentionInfo.username} Sorry, I encountered an error trying to access the Space audio.`;
             logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
             // --- END ADDED SECTION ---
             await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
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
        const ackMessage = `${mentionInfo.username} Received! I've started processing this Space from ${sourceLanguageName} to ${targetLanguageName}. Please check back here in ~10-15 minutes for the translated link.`;
        // --- ADDED: Log acknowledgement reply before sending ---
        logger.info(`[🚀 Initiate] Full Ack Reply Text: ${ackMessage}`);
        // --- END ADDED SECTION ---
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
        sourceLanguageCode,
        sourceLanguageName,
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
    const { m3u8Url, spaceId, spaceTitle, sourceLanguageCode, targetLanguageCode, mentionInfo } = initData;
    const TEMP_AUDIO_DIR = path.join(process.cwd(), 'temp_audio'); 
    // Remove video dir if not generating video
    // const TEMP_VIDEO_DIR = path.join(process.cwd(), 'temp_video'); 
    // const PLACEHOLDER_IMAGE_PATH = path.join(process.cwd(), 'placeholder.jpg');

    logger.info(`[⚙️ Backend] Starting backend processing for Space ID: ${spaceId}, Source Lang: ${sourceLanguageCode}, Target Lang: ${targetLanguageCode}`);

    let downloadedAudioPath: string | undefined = undefined;
    // let generatedVideoPath: string | undefined = undefined;
    let publicMp3Url: string | undefined = undefined;
    let projectId: string | null = null; // Initialize projectId
    
    // Initialize thirdPartyID at the top level - include tweet ID to make it unique per mention
    const projectName = spaceTitle || `Twitter Space ${spaceId}`;
    const sanitizedProjectName = projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const thirdPartyID = `${sanitizedProjectName}-${sourceLanguageCode}-to-${targetLanguageCode}-${mentionInfo.tweetId}`;

    try {
        await fs.mkdir(TEMP_AUDIO_DIR, { recursive: true });
        // await fs.mkdir(TEMP_VIDEO_DIR, { recursive: true }); // No video dir needed now
        
        // 1. Download original media and upload to S3 (video or audio depending on hasVideo flag)
        let audioUploadResult: string;
        if (mentionInfo.hasVideo) {
            logger.info(`[⚙️ Backend] Downloading/uploading original VIDEO for ${spaceId}...`);
            const videoUploadResult = await downloadAndUploadVideo(m3u8Url, spaceId);
            if (!videoUploadResult) {
                throw new Error('Failed to download/upload original video');
            }
            logger.info(`[⚙️ Backend] Original video uploaded to S3: ${videoUploadResult}`);
            audioUploadResult = videoUploadResult;
        } else {
            logger.info(`[⚙️ Backend] Downloading/uploading original Space AUDIO for ${spaceId}...`);
            const result = await downloadAndUploadAudio(m3u8Url, spaceId);
            if (!result) {
                throw new Error('Failed to download/upload original Space audio');
            }
            logger.info(`[⚙️ Backend] Original audio uploaded to S3: ${result}`);
            audioUploadResult = result;
        }
        
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

        // 4. Check if source was VIDEO - if so, look for dubbed VIDEO (not audio)
        let publicVideoUrl: string | undefined = undefined;
        let videoProcessingError: string | undefined = undefined; // Track specific error

        if (mentionInfo.hasVideo) {
            logger.info(`[⚙️ Backend] Source is video, looking for DUBBED VIDEO from SpeechLab...`);

            // Log the full project structure for debugging
            logger.debug(`[⚙️ Backend] Full completed project structure:`);
            logger.debug(JSON.stringify(completedProject, null, 2));

            // Look for dubbed VIDEO file (SpeechLab returns MP4 for video dubbing)
            let outputVideo = completedProject.translations?.[0]?.dub?.[0]?.medias?.find(d =>
                d.category === 'video' && d.format === 'mp4' && d.operationType === 'OUTPUT'
            );

            // If video not found immediately, retry up to 3 times with 10s delay (race condition fix)
            if (!outputVideo?.presignedURL) {
                logger.warn(`[⚙️ Backend] Video output not found in initial response. Retrying up to 3 times...`);
                for (let retryAttempt = 1; retryAttempt <= 3; retryAttempt++) {
                    logger.info(`[⚙️ Backend] Retry ${retryAttempt}/3: Waiting 10 seconds then re-fetching project...`);
                    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds

                    // Re-fetch the project
                    const refetchedProject = await getProjectByThirdPartyID(thirdPartyID);
                    if (refetchedProject) {
                        logger.info(`[⚙️ Backend] Re-fetched project. Checking for video output...`);
                        outputVideo = refetchedProject.translations?.[0]?.dub?.[0]?.medias?.find(d =>
                            d.category === 'video' && d.format === 'mp4' && d.operationType === 'OUTPUT'
                        );

                        if (outputVideo?.presignedURL) {
                            logger.info(`[⚙️ Backend] ✅ Found video output on retry ${retryAttempt}!`);
                            break; // Found it!
                        } else {
                            logger.warn(`[⚙️ Backend] Retry ${retryAttempt}/3: Video still not found.`);
                        }
                    } else {
                        logger.error(`[⚙️ Backend] Failed to re-fetch project on retry ${retryAttempt}.`);
                    }
                }
            }

            if (!outputVideo?.presignedURL) {
                // Log all available media to understand what we got
                const allMedias = completedProject.translations?.[0]?.dub?.[0]?.medias || [];
                logger.error(`[⚙️ Backend] ❌ DUBBED VIDEO output not found after retries!`);
                logger.error(`[⚙️ Backend] Available medias count: ${allMedias.length}`);
                allMedias.forEach((media, idx) => {
                    logger.error(`[⚙️ Backend]   Media ${idx}: category=${media.category}, format=${media.format}, operationType=${media.operationType}, hasURL=${!!media.presignedURL}`);
                });
                videoProcessingError = 'SpeechLab did not return dubbed video output after 3 retries';
            } else {
                logger.info(`[⚙️ Backend] ✅ Found DUBBED VIDEO URL: ${outputVideo.presignedURL}`);
                const TEMP_VIDEO_DIR = path.join(process.cwd(), 'temp_video');
                await fs.mkdir(TEMP_VIDEO_DIR, { recursive: true });

                const videoFilename = `${thirdPartyID}_dubbed.mp4`;
                const destinationVideoPath = path.join(TEMP_VIDEO_DIR, videoFilename);

                logger.info(`[⚙️ Backend] Downloading dubbed video to ${destinationVideoPath}...`);
                const downloadSuccess = await downloadFile(outputVideo.presignedURL, destinationVideoPath);

                if (!downloadSuccess) {
                    logger.error(`[⚙️ Backend] ❌ Failed to download dubbed video from SpeechLab presigned URL`);
                    videoProcessingError = 'Failed to download dubbed video from SpeechLab';
                } else {
                    logger.info(`[⚙️ Backend] ✅ Successfully downloaded dubbed video`);

                    // Upload to public S3
                    const publicS3Key = `dubbed-videos/${videoFilename}`;
                    logger.info(`[⚙️ Backend] Uploading dubbed video to public S3 as ${publicS3Key}...`);
                    const uploadedUrl = await uploadLocalFileToS3(destinationVideoPath, publicS3Key);

                    if (!uploadedUrl) {
                        logger.error(`[⚙️ Backend] ❌ Failed to upload dubbed video to public S3`);
                        videoProcessingError = 'Failed to upload dubbed video to S3';
                    } else {
                        publicVideoUrl = uploadedUrl;
                        logger.info(`[⚙️ Backend] ✅ Dubbed video uploaded to S3: ${publicVideoUrl}`);
                    }

                    // Cleanup local file
                    try {
                        await fs.unlink(destinationVideoPath);
                        logger.debug(`[⚙️ Backend] Cleaned up local dubbed video file`);
                    } catch (cleanupErr) {
                        logger.warn(`[⚙️ Backend] Failed to cleanup local video:`, cleanupErr);
                    }
                }
            }
        } else {
            // Source was audio (Twitter Space) - look for MP3
            logger.info(`[⚙️ Backend] Source is audio, looking for DUBBED MP3...`);
            const outputAudio = completedProject.translations?.[0]?.dub?.[0]?.medias?.find(d =>
                d.category === 'audio' && d.format === 'mp3' && d.operationType === 'OUTPUT'
            );

            if (outputAudio?.presignedURL) {
                logger.info(`[⚙️ Backend] Found DUBBED MP3 URL: ${outputAudio.presignedURL}`);
                const audioFilename = `${thirdPartyID}_dubbed.mp3`;
                const destinationAudioPath = path.join(TEMP_AUDIO_DIR, audioFilename);
                downloadedAudioPath = destinationAudioPath;

                logger.info(`[⚙️ Backend] Attempting to download dubbed audio to ${destinationAudioPath}...`);
                const downloadSuccess = await downloadFile(outputAudio.presignedURL, destinationAudioPath);

                if (!downloadSuccess) {
                     logger.warn(`[⚙️ Backend] Failed to download DUBBED audio file.`);
                     downloadedAudioPath = undefined;
                } else {
                    logger.info(`[⚙️ Backend] Successfully downloaded DUBBED audio: ${downloadedAudioPath}`);

                    // Upload the DUBBED MP3 to the PUBLIC S3 Bucket
                    const publicS3Key = `dubbed-spaces/${audioFilename}`;
                    logger.info(`[⚙️ Backend] Uploading downloaded MP3 to public S3 bucket as ${publicS3Key}...`);
                    const uploadedUrl = await uploadLocalFileToS3(downloadedAudioPath, publicS3Key);
                    if (uploadedUrl) {
                        publicMp3Url = uploadedUrl;
                        logger.info(`[⚙️ Backend] ✅ Successfully uploaded dubbed MP3 to public S3: ${publicMp3Url}`);
                    } else {
                        logger.error(`[⚙️ Backend] ❌ Failed to upload dubbed MP3 to public S3.`);
                    }
                }
            } else {
                logger.warn(`[⚙️ Backend] Could not find DUBBED MP3 audio output URL in project details.`);
            }
        }

        // 6. Generate sharing link 
        logger.info(`[⚙️ Backend] Generating sharing link for project ID: ${projectId}...`);
        const sharingLink = await generateSharingLink(projectId);
        if (!sharingLink) {
             logger.warn(`[⚙️ Backend] Failed to generate sharing link for project ${projectId}. Reply may not include link.`);
        }
        logger.info(`[⚙️ Backend] Sharing link generated: ${sharingLink || 'N/A'}`);

        // Return success with relevant URLs and error details if video processing failed
        return {
            success: true,
            sharingLink: sharingLink || undefined,
            publicMp3Url: publicMp3Url, // Will be undefined if download or S3 upload failed
            publicVideoUrl: publicVideoUrl, // Will be undefined if not a video or video processing failed
            projectId: projectId,
            thirdPartyID: thirdPartyID,
            error: videoProcessingError // Include specific error if video processing failed
        };

    } catch (error: any) {
        logger.error(`[⚙️ Backend] Error during backend processing for ${spaceId}:`, error);
        // Ensure temporary downloaded audio is cleaned up on error
        if (downloadedAudioPath) {
             logger.info(`[⚙️ Backend] Cleaning up temporary audio file due to error: ${downloadedAudioPath}`);
             await fs.unlink(downloadedAudioPath).catch(()=>{}); // Best effort cleanup
        }
        return { 
            success: false, 
            error: error.message || 'Unknown backend error', 
            thirdPartyID: thirdPartyID 
        };
    }
}

// --- Queues & Workers --- 
/**
 * Adds a completed backend job to the final reply queue and triggers the worker.
 */
function addToFinalReplyQueue(mentionInfo: MentionInfo, backendResult: BackendResult) {
    // Check if this mention has already been fully processed (reply posted)
    if (processedMentions.has(mentionInfo.tweetId)) {
        logger.warn(`[↩️ Reply Queue] Mention ${mentionInfo.tweetId} already fully processed (reply posted). Skipping duplicate add.`);
        return;
    }

    // Check if this mention is already in the reply queue to prevent duplicates
    const alreadyInQueue = finalReplyQueue.some(item => item.mentionInfo.tweetId === mentionInfo.tweetId);
    if (alreadyInQueue) {
        logger.warn(`[↩️ Reply Queue] Mention ${mentionInfo.tweetId} is already in reply queue. Skipping duplicate add.`);
        return;
    }

    logger.info(`[↩️ Reply Queue] Adding result for ${mentionInfo.tweetId} to reply queue. Success: ${backendResult.success}`);
    finalReplyQueue.push({ mentionInfo, backendResult });

    // Remove from in-progress set since it's now in reply queue
    inProgressMentions.delete(mentionInfo.tweetId);

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

    // CRITICAL: Mark as in-progress IMMEDIATELY to prevent re-queuing while backend runs
    logger.info(`[🚀 Initiate Queue] Marking ${mentionToProcess.tweetId} as in-progress to prevent duplicates.`);
    inProgressMentions.add(mentionToProcess.tweetId);

    // Update status to 'initiating'
    await updateMentionStatus(mentionToProcess.tweetId, 'initiating');

    try {
        // Perform browser initiation steps
        const initData = await initiateProcessing(mentionToProcess, page);

        // If initiation is successful, start backend processing asynchronously
        logger.info(`[🚀 Initiate Queue] Initiation successful for ${mentionToProcess.tweetId}. Starting background backend task.`);

        // Update status to 'processing' and store init data
        await updateMentionStatus(mentionToProcess.tweetId, 'processing', {
            third_party_id: initData.mentionInfo.hasVideo ? `video_${mentionToProcess.tweetId}` : undefined,
            m3u8_url: initData.m3u8Url || undefined,
            source_language: initData.sourceLanguageName,
            target_language: initData.targetLanguageName
        });
        
        // No 'await' here - let it run in the background
        performBackendProcessing(initData)
            .then(backendResult => {
                addToFinalReplyQueue(mentionToProcess, backendResult);
            })
            .catch(backendError => {
                logger.error(`[💥 Backend ERROR] Uncaught error in background processing for ${mentionToProcess.tweetId}:`, backendError);
                // Add a failure result to the reply queue so we can notify the user
                addToFinalReplyQueue(mentionToProcess, { success: false, error: 'Backend processing failed unexpectedly' });
                
                // Also log error and mark as processed to prevent requeuing
                logMentionError(mentionToProcess.tweetId, backendError, 'backend');
            });
            
    } catch (initError) {
        // Errors during initiateProcessing (including posting error replies) are logged within the function
        logger.error(`[🚀 Initiate Queue] Initiation phase failed explicitly for ${mentionToProcess.tweetId}. Error should already be logged.`);
        
        // Log error and mark as processed to prevent requeuing
        logMentionError(mentionToProcess.tweetId, initError, 'initiation');
    }

    logger.info(`[🚀 Initiate Queue] Finished browser initiation work for ${mentionToProcess.tweetId}. Queue status: ${mentionQueue.length} remaining.`);
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

    let finalMessage = ''; // Keep for potential single message fallback
    // Media attachment is currently disabled by default via config
    let mediaPathToAttach: string | undefined = undefined;

    // Construct the final message based on success and link availability
    if (backendResult.success) {
        const { sourceLanguageName, targetLanguageName } = detectLanguages(mentionInfo.text);
        const hasSharingLink = !!backendResult.sharingLink;
        const hasVideoLink = !!backendResult.publicVideoUrl;
        const hasMp3Link = !!backendResult.publicMp3Url;

        // NEW: Check for video link FIRST (videos take priority over audio)
        if (hasVideoLink && backendResult.publicVideoUrl) {
            // Video dubbing success - include SHAFT branding
            finalMessage = `${mentionInfo.username} Your video dubbed to ${targetLanguageName}! Provided by @shaftfinance $shaft`;

            // Download video for inline attachment to tweet
            logger.info(`[↩️ Reply Queue] Downloading dubbed video for inline attachment...`);
            try {
                const TEMP_VIDEO_DIR = path.join(process.cwd(), 'temp_video');
                await fs.mkdir(TEMP_VIDEO_DIR, { recursive: true });

                const videoFilename = `reply_video_${mentionInfo.tweetId}.mp4`;
                const localVideoPath = path.join(TEMP_VIDEO_DIR, videoFilename);

                const downloadSuccess = await downloadFile(backendResult.publicVideoUrl, localVideoPath);

                if (downloadSuccess) {
                    logger.info(`[↩️ Reply Queue] ✅ Video downloaded for attachment: ${localVideoPath}`);
                    mediaPathToAttach = localVideoPath;
                } else {
                    logger.warn(`[↩️ Reply Queue] Failed to download video for attachment. Will include URL in text.`);
                    finalMessage += `\n\n${backendResult.publicVideoUrl}`;
                }
            } catch (videoDownloadError) {
                logger.error(`[↩️ Reply Queue] Error downloading video for attachment:`, videoDownloadError);
                finalMessage += `\n\n${backendResult.publicVideoUrl}`;
            }
        } else if (hasMp3Link) {
            // MP3 is available - construct the success message
            let linkParts = [];
            // MP3 Link comes first
            linkParts.push(`CLICK HERE FOR MP3: ${backendResult.publicMp3Url}`);
            if (hasSharingLink) {
                 // Sharing Link comes second if available
                linkParts.push(`Link: ${backendResult.sharingLink}`);
            }
            // Construct success message with links in the desired order - ensure both usernames have @ symbols
            finalMessage = `@RyanAtSpeechlab ${mentionInfo.username} Your ${sourceLanguageName} to ${targetLanguageName} dub is ready! $shaft 🎉 ${linkParts.join(' | ')}`;
            
        } else {
            // Neither video nor MP3 is available, even though backendResult.success is true
            // Check if this was supposed to be a VIDEO or AUDIO source
            if (mentionInfo.hasVideo) {
                // Video source but video URL is missing - don't mention MP3
                logger.warn(`[↩️ Reply Queue] Backend succeeded for video tweet ${mentionInfo.tweetId} but video link is missing.`);
                logger.error(`[↩️ Reply Queue] Video processing error details: ${backendResult.error || 'Unknown error'}`);

                let partialFailureMessage = `${mentionInfo.username} Processing finished for the ${sourceLanguageName} to ${targetLanguageName} dub, but I couldn't prepare the dubbed video file. 😥`;

                // Include specific error reason if available
                if (backendResult.error) {
                    partialFailureMessage += ` Reason: ${backendResult.error}.`;
                }

                if (hasSharingLink) {
                    partialFailureMessage += ` You might find project details here: ${backendResult.sharingLink}`;
                }
                if (backendResult.projectId) {
                    partialFailureMessage += ` (Project ID: ${backendResult.projectId})`;
                }
                finalMessage = partialFailureMessage;
            } else {
                // Audio source but MP3 is missing
                logger.warn(`[↩️ Reply Queue] Backend succeeded for ${mentionInfo.tweetId} but MP3 link is missing. Posting alternative message.`);
                let partialFailureMessage = `${mentionInfo.username} Processing finished for the ${sourceLanguageName} to ${targetLanguageName} dub, but I couldn't prepare the MP3 audio file. 😥`;
                if (hasSharingLink) {
                    partialFailureMessage += ` You might find project details here: ${backendResult.sharingLink}`;
                }
                if (backendResult.projectId) {
                    partialFailureMessage += ` (Project ID: ${backendResult.projectId})`;
                }
                finalMessage = partialFailureMessage;
            }
            // Keep mediaPathToAttach as undefined in this case too
            mediaPathToAttach = undefined;
        }
        // --- END MODIFIED SECTION ---

    } else {
        // Construct error message for the single reply (original logic)
        const { sourceLanguageName, targetLanguageName } = detectLanguages(mentionInfo.text);
        const errorReason = backendResult.error || 'processing failed';
         finalMessage = `${mentionInfo.username} Oops! 😥 Couldn't complete the ${sourceLanguageName} to ${targetLanguageName} dub for this Space (${errorReason}). Maybe try again later?`;
         mediaPathToAttach = undefined; // Ensure no media attached on failure
    }
    
    // --- ADDED: Log the final constructed message before sending ---
    logger.info(`[↩️ Reply Queue] Final constructed reply text: ${finalMessage}`);
    // --- END ADDED SECTION ---

    // --- Posting Logic (Single Reply) --- 
    let postSuccess = false;

    try {
        // --- Post Final Reply --- 
        logger.info(`[↩️ Reply Queue] Posting final reply (${postMethod})...`);
        if (config.USE_TWITTER_API_FOR_REPLY) {
            postSuccess = await postTweetReplyWithMediaApi(
                finalMessage, 
                mentionInfo.tweetId, 
                mediaPathToAttach // Media only attached if applicable
            );
        } else {
            postSuccess = await postReplyToTweet(
                page, 
                mentionInfo.tweetUrl, 
                finalMessage, 
                mediaPathToAttach // Media only attached if applicable
            );
        }
        
        if (postSuccess) {
            logger.info(`[↩️ Reply Queue] Successfully posted final reply via ${postMethod} for ${mentionInfo.tweetId}.`);

            // Clean up local video file if it was attached
            if (mediaPathToAttach && mediaPathToAttach.endsWith('.mp4')) {
                try {
                    await fs.unlink(mediaPathToAttach);
                    logger.debug(`[↩️ Reply Queue] Cleaned up local video file: ${mediaPathToAttach}`);
                } catch (cleanupErr) {
                    logger.warn(`[↩️ Reply Queue] Failed to cleanup video file:`, cleanupErr);
                }
            }

            // Update Supabase with completion status
            await updateMentionStatus(mentionInfo.tweetId, 'complete', {
                third_party_id: backendResult.thirdPartyID,
                project_id: backendResult.projectId,
                sharing_link: backendResult.sharingLink,
                public_video_url: backendResult.publicVideoUrl,
                public_mp3_url: backendResult.publicMp3Url
            });

            // --- Mark Processed After Successful Reply ---
            if (backendResult.success) { // Only mark processed if the backend succeeded
                logger.info(`[↩️ Reply Queue] Marking mention ${mentionInfo.tweetId} as processed now.`);
                try {
                    await markMentionAsProcessed(mentionInfo.tweetId, processedMentions); 
                    
                    // If we have a thirdPartyID, update the project status to 'complete'
                    if (backendResult.thirdPartyID) {
                        logger.info(`[↩️ Reply Queue] Updating project status for ${backendResult.thirdPartyID} to 'complete'.`);
                        await updateProjectStatus(
                            backendResult.thirdPartyID, 
                            'complete', 
                            mentionInfo.tweetId, 
                            backendResult.projectId
                        );
                    }
                } catch (markError) {
                    // Log critical error but continue if possible
                    logger.error(`[↩️ Reply Queue] CRITICAL: Failed to mark mention ${mentionInfo.tweetId} as processed after successful reply:`, markError);
                }
             } else {
                 logger.info(`[↩️ Reply Queue] Backend failed, marking mention ${mentionInfo.tweetId} as processed to prevent requeuing.`);
                 // Always mark as processed even if backend failed
                 await markMentionAsProcessed(mentionInfo.tweetId, processedMentions);
                 
                 // Update Supabase with failed status
                 await updateMentionStatus(mentionInfo.tweetId, 'failed', {
                     error_message: backendResult.error || 'Unknown backend error'
                 });

                 // If we have a thirdPartyID, update the project status to 'failed'
                 if (backendResult.thirdPartyID) {
                     logger.info(`[↩️ Reply Queue] Updating project status for ${backendResult.thirdPartyID} to 'failed'.`);
                     await updateProjectStatus(
                         backendResult.thirdPartyID,
                         'failed',
                         mentionInfo.tweetId,
                         backendResult.projectId
                     );
                 }

                 // Log to error log file
                 logMentionError(mentionInfo.tweetId, backendResult.error || 'Unknown backend error', 'backend');
             }

            // --- Clean up DOWNLOADED MP3 --- 
            if (backendResult.success && backendResult.publicMp3Url) { // Only cleanup if backend succeeded AND MP3 link existed (meaning download likely happened)
                // Extract language codes for potential audio file cleanup
                const { sourceLanguageCode, targetLanguageCode } = detectLanguages(mentionInfo.text);
                // !! This title reconstruction for cleanup is FRAGILE !!
                // It assumes the title used during backend processing was 'temp' if original was missing.
                // A better approach would be to pass the actual used thirdPartyID back in BackendResult.
                const spaceTitle = 'temp'; 
                const sanitizedProjectName = spaceTitle.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
                const thirdPartyID = `${sanitizedProjectName}-${sourceLanguageCode}-to-${targetLanguageCode}`;
                const TEMP_AUDIO_DIR = path.join(process.cwd(), 'temp_audio');
                const assumedAudioFilename = `${thirdPartyID}_dubbed.mp3`;
                const assumedDownloadedAudioPath = path.join(TEMP_AUDIO_DIR, assumedAudioFilename);

                logger.info(`[↩️ Reply Queue] Attempting cleanup of temporary audio file: ${assumedDownloadedAudioPath}`);
                try {
                    await fs.access(assumedDownloadedAudioPath);
                    await fs.unlink(assumedDownloadedAudioPath);
                    logger.info(`[↩️ Reply Queue] Successfully deleted temporary audio file.`);
                } catch (err) {
                    logger.warn(`[↩️ Reply Queue] Failed to delete or access temp audio ${assumedDownloadedAudioPath} (may have already been deleted or reconstruction failed):`, err);
                }
            }
            // -----------------------------
        } else {
            logger.warn(`[↩️ Reply Queue] Failed to post final reply via ${postMethod} for ${mentionInfo.tweetId}. Marking as processed anyway to prevent requeuing.`);
            // Mark as processed even if reply failed
            await markMentionAsProcessed(mentionInfo.tweetId, processedMentions);
            // Log to error log file
            logMentionError(mentionInfo.tweetId, 'Failed to post reply', 'reply');
        }
    } catch (replyError) {
        logger.error(`[↩️ Reply Queue] CRITICAL: Error posting final ${postMethod} reply for ${mentionInfo.tweetId}:`, replyError);
        // Mark as processed even if reply throws error
        await markMentionAsProcessed(mentionInfo.tweetId, processedMentions);
        // Log to error log file
        logMentionError(mentionInfo.tweetId, replyError, 'reply');
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

    // Initialize Supabase
    logger.info('[😈 Daemon] Initializing Supabase connection...');
    initSupabase();

    // Load processed mentions from Supabase
    logger.info('[😈 Daemon] Loading processed mentions from Supabase...');
    const supabaseProcessedMentions = await getAllProcessedMentions();
    for (const tweetId of supabaseProcessedMentions) {
        processedMentions.add(tweetId);
    }
    logger.info(`[😈 Daemon] Loaded ${supabaseProcessedMentions.size} processed mentions from Supabase`);

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
                const mentions = await scrapeMentions(page, processedMentions);
                let newMentionsFound = 0;
                
                // Create a preview of new mentions being added
                const newMentions: MentionInfo[] = [];
                // Track mentions we've seen in this batch to avoid duplicates in the same poll
                const seenInThisBatch = new Set<string>();
                // Check current queue IDs to avoid adding duplicates
                const currentQueueIds = new Set(mentionQueue.map(m => m.tweetId));
                // Also check reply queue to avoid re-queuing mentions that are waiting for final reply
                const replyQueueIds = new Set(finalReplyQueue.map(r => r.mentionInfo.tweetId));

                for (const mention of mentions) {
                    // Skip if already fully processed, currently in-progress, in any queue, or already seen in this batch
                    if (processedMentions.has(mention.tweetId) ||
                        inProgressMentions.has(mention.tweetId) ||
                        currentQueueIds.has(mention.tweetId) ||
                        replyQueueIds.has(mention.tweetId) ||
                        seenInThisBatch.has(mention.tweetId)) {
                        continue;
                    }

                    // Skip tweets from the bot itself (avoid processing own replies as mentions)
                    if (config.TWITTER_USERNAME) {
                        const botUsername = config.TWITTER_USERNAME.toLowerCase();
                        const mentionUsername = mention.username.toLowerCase().replace('@', '');
                        if (mentionUsername === botUsername) {
                            logger.debug(`[🔔 Mention] Skipping bot's own tweet: ${mention.tweetId}`);
                            continue;
                        }
                    }

                    // Mark as seen in this batch
                    seenInThisBatch.add(mention.tweetId);

                    // Check Supabase for existing mention status - simple logic:
                    // If NOT in DB → add and process
                    // If status is 'complete' → skip (already done)
                    // Otherwise (pending, initiating, processing, failed) → retry
                    const existingMention = await getMention(mention.tweetId);

                    if (existingMention) {
                        logger.info(`[🔔 Mention] Found mention ${mention.tweetId} in Supabase with status: ${existingMention.status}`);

                        // Only skip if status is 'complete' (final tweet was posted successfully)
                        if (existingMention.status === 'complete') {
                            logger.info(`[🔔 Mention] Mention ${mention.tweetId} is complete. Skipping.`);
                            await markMentionAsProcessed(mention.tweetId, processedMentions);
                            continue;
                        }

                        // If status is 'processing' and it has all the completion data (video URLs, sharing link),
                        // it means it was successfully processed but just never marked complete. Mark it complete now.
                        if (existingMention.status === 'processing' &&
                            existingMention.public_video_url &&
                            existingMention.sharing_link) {
                            logger.info(`[🔔 Mention] Mention ${mention.tweetId} has status 'processing' but has all completion data. Marking as complete.`);
                            await updateMentionStatus(mention.tweetId, 'complete');
                            await markMentionAsProcessed(mention.tweetId, processedMentions);
                            continue;
                        }

                        // For any other status (pending, initiating, failed) or processing without completion data, retry
                        logger.info(`[🔔 Mention] Mention ${mention.tweetId} has status '${existingMention.status}'. Will retry processing.`);
                    }

                    // Process the mention (new or retry)
                    newMentionsFound++;
                    const actionType = existingMention ? 'Retrying' : 'Found new';
                    logger.info(`[🔔 Mention] ${actionType} mention: ID=${mention.tweetId}, User=${mention.username}, Text="${mention.text?.substring(0, 50)}${mention.text?.length > 50 ? '...' : ''}"`);

                    // Add/update in Supabase with 'pending' status
                    await upsertMention({
                        tweet_id: mention.tweetId,
                        username: mention.username,
                        tweet_url: mention.tweetUrl,
                        tweet_text: mention.text || '',
                        status: 'pending'
                    });

                    mentionQueue.push(mention);
                    newMentions.push(mention);
                    logger.info(`[⚙️ Queue] Mention ${mention.tweetId} added to initiation queue. Queue size: ${mentionQueue.length}`);
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
                    logger.debug('[😈 Daemon Polling] No new mentions found.');
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
            logger.warn(`[😈 Daemon] SKIP_INITIAL_MENTIONS flag is set. Marking mentions older than 30 minutes as complete...`);
            try {
                if (!page || page.isClosed()) {
                    throw new Error("Page closed before initial skip scrape could run.");
                }
                // Scrape mentions once to find what's currently on the page
                const initialMentions = await scrapeMentions(page, processedMentions);
                logger.info(`[😈 Daemon] Initial scrape found ${initialMentions.length} mentions (already-processed filtered).`);

                const now = Date.now();
                const THIRTY_MINUTES_MS = 30 * 60 * 1000;
                let skippedCount = 0;
                let keptCount = 0;

                for (const mention of initialMentions) {
                    // Check if it's *not* already processed, just in case
                    if (!processedMentions.has(mention.tweetId)) {
                        // Calculate mention age from Twitter Snowflake ID
                        // Twitter Snowflake IDs encode timestamp in first 41 bits
                        const tweetTimestamp = (BigInt(mention.tweetId) >> BigInt(22)) + BigInt(1288834974657); // Twitter epoch
                        const tweetDate = new Date(Number(tweetTimestamp));
                        const mentionAge = now - tweetDate.getTime();
                        const ageMinutes = Math.round(mentionAge / 60000);

                        // Only skip mentions older than 30 minutes
                        if (mentionAge > THIRTY_MINUTES_MS) {
                            logger.info(`[😈 Daemon] Marking old mention ${mention.tweetId} (${ageMinutes} min old) as complete (skipping queue).`);

                            // Mark the mention as processed in local cache
                            await markMentionAsProcessed(mention.tweetId, processedMentions);

                            // Update Supabase to status 'complete' so it won't be retried
                            await updateMentionStatus(mention.tweetId, 'complete', {
                                error_message: `Skipped - ${ageMinutes} minutes old at daemon startup with SKIP_INITIAL_MENTIONS=true`
                            });

                            skippedCount++;
                        } else {
                            logger.info(`[😈 Daemon] Keeping recent mention ${mention.tweetId} (${ageMinutes} min old) - will process normally.`);
                            keptCount++;
                        }
                    } else {
                         logger.debug(`[😈 Daemon] Initially found mention ${mention.tweetId} was already marked as processed.`);
                    }
                }
                logger.info(`[😈 Daemon] Finished: ${skippedCount} old mentions marked complete, ${keptCount} recent mentions kept for processing.`);

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
            
            // Check flags: Process both queues independently
            // Trigger initiation worker if not already running and queue has items
            if (!isInitiatingProcessing && mentionQueue.length > 0) {
                logger.debug('[😈 Daemon Task Loop] Triggering Initiation Queue check...');
                triggerInitiationWorker(page);
            }

            // Trigger reply worker if not already running and queue has items
            if (!isPostingFinalReply && finalReplyQueue.length > 0) {
                logger.debug('[😈 Daemon Task Loop] Triggering Final Reply Queue check...');
                triggerFinalReplyWorker(page);
            }

            if (isInitiatingProcessing || isPostingFinalReply || mentionQueue.length > 0 || finalReplyQueue.length > 0) {
                // At least one queue is active or has items
            } else {
                // logger.debug('[😈 Daemon Task Loop] Browser idle, all queues empty.');
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