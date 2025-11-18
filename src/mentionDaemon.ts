import { config } from './utils/config';
import logger from './utils/logger';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    MentionInfo,
    extractSpaceUrl,
    extractSpaceId,
    findSpaceUrlOnPage,
    clickPlayButtonAndCaptureM3u8,
    extractSpaceTitleFromModal,
    getVideoM3u8FromMention
} from './services/twitterInteractionService';
import { fetchMentions, postReplyWithMedia, MentionData, fetchVideoForMention, testTwitterApiConnection } from './services/twitterMentionService';
import { downloadAndUploadAudio, downloadAndUploadVideo } from './services/audioService';
import { createDubbingProject, waitForProjectCompletion, generateSharingLink, getProjectByThirdPartyID } from './services/speechlabApiService';
import { detectLanguage, detectLanguages, getLanguageName, isValidDubbingRequest } from './utils/languageUtils';
import { v4 as uuidv4 } from 'uuid';
import { downloadFile } from './utils/fileUtils';
import { mergeVideoDubbedAudio, extractAudioFromVideo } from './utils/videoUtils';
import { exec } from 'child_process';
import util from 'util';
import { postTweetReplyWithMediaApi } from './services/twitterApiService';
import { uploadLocalFileToS3 } from './services/audioService';
import * as fsExtra from 'fs-extra';
import { initSupabase, upsertMention, updateMentionStatus, getAllProcessedMentions, getMention, getStuckMentions, getUnprocessedMentions } from './services/supabaseService';

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
let processedMentions: Set<string> = new Set(); // Only mentions with status='complete' or 'failed'
let skippedInvalidMentions: Set<string> = new Set(); // Invalid dubbing requests (not retried)
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
const POLLING_INTERVAL_MS = config.MENTION_POLL_INTERVAL_MS || (2 * 60 * 1000); // Check every 2 minutes (7-8 polls per 15min window - safe buffer)
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

// Login functions removed - using Twitter API instead

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
 * Saves a mention ID to Supabase (single source of truth)
 * NOTE: No longer saves to JSON file - using Supabase only
 */
async function markMentionAsProcessed(mentionId: string, processedMentions: Set<string>): Promise<void> {
    if (processedMentions.has(mentionId)) {
        logger.debug(`[😈 Daemon] Mention ${mentionId} is already in the processed set.`);
        return;
    }

    processedMentions.add(mentionId);
    logger.debug(`[😈 Daemon] Marked mention ${mentionId} as processed in memory (Supabase is source of truth).`);
    // Note: Mention is already being tracked in Supabase via upsertMention() and updateMentionStatus()
    // No need for separate persistence here
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

// ==================================================================================
// BROWSER-DEPENDENT FUNCTIONS BELOW - REQUIRE PLAYWRIGHT REFACTORING FOR API-ONLY
// ==================================================================================
// These functions are not currently used since browser task loops have been removed.
// They require significant refactoring to work with Twitter API instead of Playwright.
// TODO: Refactor to use Twitter API for media detection and Space/video URL extraction
// ==================================================================================

/**
 * Helper to find the article OR the direct button for playing a Space recording.
 * Prioritizes finding within an article, then falls back to searching the whole page.
 * @returns A Locator for either the containing article OR the button itself, or null.
 * @deprecated Requires Playwright - needs API refactoring
 */
async function findArticleWithPlayButton(page: any): Promise<any | null> {
    logger.debug('[🐦 Helper] Searching for playable Space element (button or article)...');

    // Multiple regex patterns to match different button text variants
    const playButtonPatterns = [
        /Play recording/i,    // Original pattern
        /^Play$/i,            // Simple "Play" button
        /Play Space/i,        // "Play Space" variant
        /Listen/i,            // "Listen" variant
        /Playback/i           // "Playback" variant
    ];

    const articleSelector = 'article[data-testid="tweet"]';

    // Build flexible XPath that matches any of the button text variants
    const xpathConditions = [
        "contains(@aria-label, 'Play recording')",
        "contains(@aria-label, 'Play Space')",
        "contains(@aria-label, 'Play')",
        "contains(@aria-label, 'Listen')",
        ".//span[contains(text(), 'Play recording')]",
        ".//span[contains(text(), 'Play Space')]",
        ".//span[text()='Play']",
        ".//span[contains(text(), 'Listen')]"
    ];
    const flexibleButtonXPath = `//button[${xpathConditions.join(' or ')}]`;

    // --- Strategy 1: Find button within articles using getByRole (try all patterns) ---
    logger.debug(`[🐦 Helper] Strategy 1: Searching within articles (${articleSelector}) using getByRole...`);
    const articles = await page.locator(articleSelector).all();
    for (let i = 0; i < articles.length; i++) {
        const article = articles[i];
        if (!await article.isVisible().catch(() => false)) {
             logger.debug(`[🐦 Helper] Article ${i + 1} is not visible, skipping.`);
             continue;
         }

        // Try each pattern
        for (const pattern of playButtonPatterns) {
            const buttonInArticle = article.getByRole('button', { name: pattern }).first();
            if (await buttonInArticle.isVisible({ timeout: 500 }).catch(() => false)) {
                logger.info(`[🐦 Helper] Found Play button in article ${i + 1} using pattern: ${pattern}. Returning article.`);
                return article; // Return the article containing the button
            }
        }
    }

    // --- Strategy 2: Find button directly on page using getByRole (try all patterns) ---
    logger.info('[🐦 Helper] Strategy 2: Searching page-level using getByRole...');
    for (const pattern of playButtonPatterns) {
        const buttonByRole = page.getByRole('button', { name: pattern }).first();
        if (await buttonByRole.isVisible({ timeout: 1000 }).catch(() => false)) {
            logger.info(`[🐦 Helper] Found Play button using pattern: ${pattern} directly on page. Returning button locator.`);
            return buttonByRole;
        }
    }

    // --- Strategy 3: Find button directly on page using flexible XPath ---
    logger.info('[🐦 Helper] Strategy 3: Searching page-level using flexible XPath...');
    const buttonByXPath = page.locator(flexibleButtonXPath).first();
    if (await buttonByXPath.isVisible({ timeout: 1000 }).catch(() => false)) {
        logger.info('[🐦 Helper] Found Play button using flexible XPath directly on page. Returning button locator.');
        return buttonByXPath;
    }

    // --- Strategy 4: Fallback to generic aria-label search for any play-related button ---
    logger.info('[🐦 Helper] Strategy 4: Fallback search for any play-related button...');
    const genericPlayXPath = "//button[contains(translate(@aria-label, 'PLAY', 'play'), 'play')]";
    const genericPlayButton = page.locator(genericPlayXPath).first();
    if (await genericPlayButton.isVisible({ timeout: 1000 }).catch(() => false)) {
        logger.info('[🐦 Helper] Found generic play button using fallback XPath. Returning button locator.');
        return genericPlayButton;
    }

    logger.warn('[🐦 Helper] Could not find any playable element using any detection strategy.');
    return null;
}

// --- DEPRECATED: Browser-dependent initiation steps ---
/**
 * Handles the initial browser interaction for a mention:
 * - Navigates to the mention tweet.
 * - Finds the playable Space article.
 * - Clicks Play and captures the M3U8 URL.
 * - Posts an acknowledgement reply.
 * @returns Data needed for backend processing.
 * @throws Error if initiation fails (error reply should be attempted internally).
 * @deprecated Requires Playwright - needs API refactoring to extract media URLs
 */
async function initiateProcessing(mentionInfo: MentionInfo, page: any): Promise<InitiationResult> {
    logger.info(`[🚀 Initiate] Starting browser phase for ${mentionInfo.tweetId}`);
    // Rename variable to reflect it might be article OR button
    let playElementLocator: any | null = null;

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
                const spaceTitle = `Video from ${ensureAtSymbol(mentionInfo.username)}`;

                // Post acknowledgement reply
                try {
                    logger.info(`[🎬 Initiate] Posting preliminary acknowledgement reply for video...`);
                    const ackMessage = `${mentionInfo.username} Received! I've started processing this video from ${sourceLanguageName} to ${targetLanguageName}. Please check back here in ~10-15 minutes for the dubbed video.`;
                    logger.info(`[🎬 Initiate] Full Ack Reply Text: ${ackMessage}`);
                    // TODO: Replace with API call: const ackSuccess = await postReplyWithMedia(ackMessage, mentionInfo.tweetId);
                    const ackSuccess = false; // await postReplyToTweet(page, mentionInfo.tweetUrl, ackMessage);
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
                const videoErrorDetails = [
                    'Video M3U8 Extraction Failed:',
                    'Video detected in mention but M3U8 URL could not be captured',
                    `Tweet: ${mentionInfo.tweetUrl}`,
                    'Possible causes: Protected video, DRM, network interception failed, M3U8 URL pattern changed'
                ].join(' | ');

                logger.warn(`[🎬 Initiate] ${videoErrorDetails}`);
                const errorReplyText = `${ensureAtSymbol(mentionInfo.username)} Sorry, I found a video but couldn't extract the stream URL. The video might be protected or not yet available.`;
                logger.info(`[🎬 Initiate] Posting error reply: ${errorReplyText}`);
                // TODO: Replace with API call: await postReplyWithMedia(errorReplyText, mentionInfo.tweetId);
                // await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
                throw new Error(`Video M3U8 extraction failed - ${videoErrorDetails}`);
            } else {
                logger.info(`[🎬 Initiate] No video found in mention. Will try Space detection next.`);
                // Don't throw - let it fall through to Space detection
            }
        } catch (videoError) {
            const errorMsg = videoError instanceof Error ? videoError.message : String(videoError);
            logger.error(`[🎬 Initiate] Error during video detection: ${errorMsg}`);
            // If error was thrown with a message, it already posted a reply - don't continue to Space detection
            if (videoError instanceof Error && videoError.message.includes('M3U8 extraction failed')) {
                throw videoError; // Stop here, error reply already posted, detailed error will be saved to DB
            }
            // Otherwise, log and continue to Space detection as fallback
            logger.info(`[🎬 Initiate] Continuing to Space detection after video error: ${errorMsg}`);
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
            // Build detailed error message with detection strategies attempted
            const detectionInfo = [
                'Spaces Detection Failed - All strategies exhausted:',
                '1. Searched for buttons with text: "Play recording", "Play", "Play Space", "Listen", "Playback"',
                '2. Checked within article elements using getByRole',
                '3. Checked page-level using getByRole',
                '4. Tried flexible XPath matching aria-labels and spans',
                '5. Attempted generic play button fallback',
                `Tweet URL: ${mentionInfo.tweetUrl}`,
                spaceUrl ? `Space URL provided: ${spaceUrl}` : 'No Space URL in mention text',
                config.PROCESS_VIDEO_IN_MENTIONS ? 'Video processing enabled - already checked for video' : 'Video processing disabled'
            ].join(' | ');

            const errMsg = `Spaces button not found after 4 detection strategies (${mentionInfo.tweetId})`;
            logger.warn(`[🚀 Initiate] ${errMsg}`);
            logger.warn(`[🚀 Initiate] Detection Details: ${detectionInfo}`);

            // Check if this was a text-only mention (no video, no Space)
            if (!spaceUrl && config.PROCESS_VIDEO_IN_MENTIONS) {
                // This was a text-only mention with no content to process
                const errorReplyText = `${ensureAtSymbol(mentionInfo.username)} To dub content, please:\n1. Attach a video to your mention, OR\n2. Include a Twitter Space URL in your tweet\n\nExample: "@DubbingAgent [video attached] dub to German"`;
                logger.info(`[🚀 Initiate] Posting helpful error reply for text-only mention: ${errorReplyText}`);
                // TODO: Replace with API call: await postReplyWithMedia(errorReplyText, mentionInfo.tweetId);
                // await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
            } else {
                // Normal Space not found error
                const errorReplyText = `${ensureAtSymbol(mentionInfo.username)} Sorry, I couldn't find a playable Twitter Space associated with this tweet.`;
                logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
                // TODO: Replace with API call: await postReplyWithMedia(errorReplyText, mentionInfo.tweetId);
                // await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
            }
            throw new Error(`${errMsg} - ${detectionInfo}`); // Throw detailed error
        }
        logger.info(`[🚀 Initiate] Found potential Space element (article or button).`);

    } catch (error) {
        logger.error(`[🚀 Initiate] Error during navigation/article finding for ${mentionInfo.tweetId}:`, error);
        // Try to post error reply if possible (and if it wasn't the error above)
        if (!(error instanceof Error && error.message.includes('Playable Space article not found'))) {
            try {
                 // --- ADDED: Log error reply before sending ---
                 const errorReplyText = `${ensureAtSymbol(mentionInfo.username)} Sorry, I had trouble loading the tweet to find the Space.`;
                 logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
                 // TODO: Replace with API call: await postReplyWithMedia(errorReplyText, mentionInfo.tweetId);
                 // await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
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
            const tagName = await playElementLocator.evaluate((el: any) => el.tagName.toLowerCase()).catch(() => '');
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
             const m3u8ErrorDetails = [
                 'M3U8 Capture Failed:',
                 'Found playable Space element but M3U8 URL was not captured after clicking Play',
                 `Tweet: ${mentionInfo.tweetUrl}`,
                 'Possible causes: Space ended/expired, no network request intercepted, M3U8 URL pattern changed, page loaded incorrectly'
             ].join(' | ');

             logger.error(`[🚀 Initiate] ${m3u8ErrorDetails}`);
            // --- ADDED: Log error reply before sending ---
            const errorReplyText = `${ensureAtSymbol(mentionInfo.username)} Sorry, I could find the Space but couldn't get its audio stream. It might be finished or protected.`;
            logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
            // TODO: Replace with API call: await postReplyWithMedia(errorReplyText, mentionInfo.tweetId);
            // await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
             throw new Error(`M3U8 capture failed - ${m3u8ErrorDetails}`);
        }
        logger.info(`[🚀 Initiate] Captured M3U8 URL: ${m3u8Url.substring(0, 100)}...`);

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
         const errorMsg = error instanceof Error ? error.message : String(error);
         logger.error(`[🚀 Initiate] Error during M3U8 capture for ${mentionInfo.tweetId}: ${errorMsg}`);
         try {
             // --- ADDED: Log error reply before sending ---
             const errorReplyText = `${ensureAtSymbol(mentionInfo.username)} Sorry, I encountered an error trying to access the Space audio.`;
             logger.info(`[🚀 Initiate] Posting error reply: ${errorReplyText}`);
             // TODO: Replace with API call: await postReplyWithMedia(errorReplyText, mentionInfo.tweetId);
             // await postReplyToTweet(page, mentionInfo.tweetUrl, errorReplyText);
         } catch(replyError) { /* Ignore */ }
         throw error; // Detailed error will be saved to DB
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
        // TODO: Replace with API call: const ackSuccess = await postReplyWithMedia(ackMessage, mentionInfo.tweetId);
        const ackSuccess = false; // await postReplyToTweet(page, mentionInfo.tweetUrl, ackMessage);
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
        let completedProject = await waitForProjectCompletion(thirdPartyID, maxWaitTimeMs); 
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

            // Project completed - log summary only
            logger.debug(`[⚙️ Backend] Project completed: ID=${completedProject.id}, status=${completedProject.job?.status}`);

            // Look for dubbed VIDEO file (SpeechLab returns MP4 for video dubbing)
            logger.info(`[⚙️ Backend] ========================================`);
            logger.info(`[⚙️ Backend] 🔍 SEARCHING FOR VIDEO OUTPUT IN SPEECHLAB RESPONSE`);
            logger.info(`[⚙️ Backend] ========================================`);
            logger.info(`[⚙️ Backend] Project ID: ${completedProject.id}`);
            logger.info(`[⚙️ Backend] Translations count: ${completedProject.translations?.length || 0}`);

            if (completedProject.translations?.[0]) {
                logger.info(`[⚙️ Backend] First translation - dub count: ${completedProject.translations[0].dub?.length || 0}`);

                if (completedProject.translations[0].dub?.[0]) {
                    const firstDub = completedProject.translations[0].dub[0];
                    logger.info(`[⚙️ Backend] First dub - medias count: ${firstDub.medias?.length || 0}`);

                    if (firstDub.medias && firstDub.medias.length > 0) {
                        logger.info(`[⚙️ Backend] ALL MEDIAS IN FIRST DUB:`);
                        firstDub.medias.forEach((media, idx) => {
                            logger.info(`[⚙️ Backend]   Media[${idx}]:`);
                            logger.info(`[⚙️ Backend]     - category: ${media.category}`);
                            logger.info(`[⚙️ Backend]     - format: ${media.format}`);
                            logger.info(`[⚙️ Backend]     - operationType: ${media.operationType}`);
                            logger.info(`[⚙️ Backend]     - presignedURL exists: ${!!media.presignedURL}`);
                            if (media.presignedURL) {
                                logger.info(`[⚙️ Backend]     - presignedURL: ${media.presignedURL.substring(0, 100)}...`);
                            }
                        });
                    }
                }
            }
            logger.info(`[⚙️ Backend] ========================================`);

            let outputVideo = completedProject.translations?.[0]?.dub?.[0]?.medias?.find(d =>
                d.category === 'video' && d.format === 'mp4' && d.operationType === 'OUTPUT'
            );

            if (outputVideo?.presignedURL) {
                logger.info(`[⚙️ Backend] ✅ FOUND VIDEO OUTPUT: category=${outputVideo.category}, format=${outputVideo.format}, operationType=${outputVideo.operationType}`);
            } else {
                logger.error(`[⚙️ Backend] ❌ VIDEO OUTPUT NOT FOUND with criteria: category='video', format='mp4', operationType='OUTPUT'`);
            }

            // If video not found immediately, retry up to 10 times with increasing delays
            // (Speechlab might still be uploading the video to S3)
            if (!outputVideo?.presignedURL) {
                logger.warn(`[⚙️ Backend] Video output not found in initial response. Retrying up to 10 times with exponential backoff...`);
                const retryDelays = [5000, 5000, 10000, 10000, 15000, 20000, 30000, 30000, 45000, 60000]; // Total: ~4 minutes

                for (let retryAttempt = 1; retryAttempt <= retryDelays.length; retryAttempt++) {
                    const delayMs = retryDelays[retryAttempt - 1];
                    const delaySec = (delayMs / 1000).toFixed(0);
                    logger.info(`[⚙️ Backend] Retry ${retryAttempt}/${retryDelays.length}: Waiting ${delaySec}s then re-fetching project from Speechlab API...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));

                    // Re-fetch the project from Speechlab API
                    const refetchedProject = await getProjectByThirdPartyID(thirdPartyID);
                    if (refetchedProject) {
                        logger.info(`[⚙️ Backend] Re-fetched project ${refetchedProject.id}. Status: ${refetchedProject.job?.status}. Checking for video output...`);

                        // Update completedProject reference for final logging
                        completedProject = refetchedProject;

                        outputVideo = refetchedProject.translations?.[0]?.dub?.[0]?.medias?.find(d =>
                            d.category === 'video' && d.format === 'mp4' && d.operationType === 'OUTPUT'
                        );

                        if (outputVideo?.presignedURL) {
                            logger.info(`[⚙️ Backend] ✅ Found video output on retry ${retryAttempt}! URL: ${outputVideo.presignedURL}`);
                            break; // Found it!
                        } else {
                            const availableMedias = refetchedProject.translations?.[0]?.dub?.[0]?.medias || [];
                            logger.warn(`[⚙️ Backend] Retry ${retryAttempt}/${retryDelays.length}: Video still not found. Available media count: ${availableMedias.length}`);

                            // Log what we found on every 3rd retry
                            if (retryAttempt % 3 === 0) {
                                availableMedias.forEach((media, idx) => {
                                    logger.info(`[⚙️ Backend]   Media ${idx}: ${media.category}/${media.format}/${media.operationType} - hasURL: ${!!media.presignedURL}`);
                                });
                            }
                        }
                    } else {
                        logger.error(`[⚙️ Backend] Failed to re-fetch project from Speechlab API on retry ${retryAttempt}.`);
                    }
                }

                if (!outputVideo?.presignedURL) {
                    logger.error(`[⚙️ Backend] ❌ Video URL still not available after ${retryDelays.length} retries (~4 minutes of waiting).`);
                }
            }

            if (!outputVideo?.presignedURL) {
                // Log all available media to understand what we got
                const allMedias = completedProject.translations?.[0]?.dub?.[0]?.medias || [];
                logger.error(`[⚙️ Backend] ========================================`);
                logger.error(`[⚙️ Backend] ❌ DUBBED VIDEO output not found after retries!`);
                logger.error(`[⚙️ Backend] ========================================`);
                logger.error(`[⚙️ Backend] Project ID: ${completedProject.id}`);
                logger.error(`[⚙️ Backend] ThirdPartyID: ${thirdPartyID}`);
                logger.error(`[⚙️ Backend] Project Status: ${completedProject.job?.status}`);
                logger.error(`[⚙️ Backend] Available medias count: ${allMedias.length}`);
                logger.error(`[⚙️ Backend] ========================================`);

                allMedias.forEach((media, idx) => {
                    logger.error(`[⚙️ Backend] Media ${idx}:`);
                    logger.error(`[⚙️ Backend]   - category: ${media.category}`);
                    logger.error(`[⚙️ Backend]   - format: ${media.format}`);
                    logger.error(`[⚙️ Backend]   - operationType: ${media.operationType}`);
                    logger.error(`[⚙️ Backend]   - hasURL: ${!!media.presignedURL}`);
                    logger.error(`[⚙️ Backend]   - url: ${media.presignedURL || 'NONE'}`);
                });

                logger.error(`[⚙️ Backend] ========================================`);
                logger.error(`[⚙️ Backend] Project ID: ${completedProject.id} - No valid video output found`);
                logger.error(`[⚙️ Backend] ========================================`);

                videoProcessingError = 'SpeechLab did not return dubbed video output after 3 retries - check logs for full response';
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

/**
 * Checks Supabase for mentions stuck in 'initiating' or 'processing' status
 * and retries them if they've been stuck longer than the timeout period.
 */
async function retryStuckMentions(stuckTimeoutMs: number): Promise<void> {
    try {
        logger.info('[🔄 Retry] Checking for stuck mentions in Supabase...');

        const stuckMentions = await getStuckMentions();

        if (!stuckMentions || stuckMentions.length === 0) {
            logger.info('[🔄 Retry] No stuck mentions found.');
            return;
        }

        const now = Date.now();
        let retriedCount = 0;

        for (const mention of stuckMentions) {
            // Skip if updated_at is missing
            if (!mention.updated_at) {
                logger.warn(`[🔄 Retry] Mention ${mention.tweet_id} has no updated_at timestamp - skipping`);
                continue;
            }

            const updatedAt = new Date(mention.updated_at as string).getTime();
            const stuckDuration = now - updatedAt;
            const stuckMinutes = Math.floor(stuckDuration / 60000);

            if (stuckDuration < stuckTimeoutMs) {
                logger.debug(`[🔄 Retry] Mention ${mention.tweet_id} (${mention.status}) stuck for ${stuckMinutes}m - not yet timed out`);
                continue;
            }

            // Check retry count - mark as final_failure if already retried 3+ times
            const retryCount = mention.retry_count || 0;
            if (retryCount >= 3) {
                logger.warn(`[🔄 Retry] ❌ Mention ${mention.tweet_id} has already been retried ${retryCount} times - marking as final_failure`);
                await updateMentionStatus(mention.tweet_id, 'final_failure' as any, {
                    error_message: `Failed after ${retryCount} retry attempts`
                });
                continue;
            }

            // Skip if already in queue or in-progress
            if (inProgressMentions.has(mention.tweet_id) ||
                mentionQueue.some(m => m.tweetId === mention.tweet_id) ||
                finalReplyQueue.some(r => r.mentionInfo.tweetId === mention.tweet_id)) {
                logger.debug(`[🔄 Retry] Mention ${mention.tweet_id} already being processed - skipping retry`);
                continue;
            }

            logger.warn(`[🔄 Retry] 🔁 Mention ${mention.tweet_id} (${ensureAtSymbol(mention.username)}) stuck in '${mention.status}' for ${stuckMinutes}m - RETRYING (attempt ${retryCount + 1}/3)`);

            // Increment retry count and reset status to 'pending'
            const newRetryCount = retryCount + 1;
            const updateSuccess = await upsertMention({
                tweet_id: mention.tweet_id,
                username: mention.username,
                tweet_url: mention.tweet_url,
                tweet_text: mention.tweet_text,
                status: 'pending',
                retry_count: newRetryCount
            });

            if (!updateSuccess) {
                logger.error(`[🔄 Retry] Failed to reset status for ${mention.tweet_id}`);
                continue;
            }

            // Fetch video for this mention
            const { videoUrl } = await fetchVideoForMention(mention.tweet_id);

            // Add back to mention queue
            mentionQueue.push({
                tweetId: mention.tweet_id,
                tweetUrl: `https://twitter.com/user/status/${mention.tweet_id}`,
                username: mention.username,
                text: mention.tweet_text,
                hasVideo: !!videoUrl,
                videoM3u8Url: videoUrl || undefined
            });

            retriedCount++;
            logger.info(`[🔄 Retry] ✅ Re-queued stuck mention ${mention.tweet_id} for retry (${retriedCount} retried)`);
        }

        if (retriedCount > 0) {
            logger.info(`[🔄 Retry] 🔁 Retried ${retriedCount} stuck mention(s). Queue size now: ${mentionQueue.length}`);
        } else {
            logger.info(`[🔄 Retry] No mentions needed retry (${stuckMentions.length} stuck but within timeout or already queued)`);
        }

    } catch (error) {
        logger.error('[🔄 Retry] Unexpected error in retryStuckMentions:', error);
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

    // CRITICAL: Add to processedMentions IMMEDIATELY when adding to queue
    // This prevents the same mention from being added multiple times if there's any delay
    logger.info(`[↩️ Reply Queue] IMMEDIATELY marking ${mentionInfo.tweetId} in processedMentions Set to prevent duplicate queue adds`);
    processedMentions.add(mentionInfo.tweetId);
    logger.info(`[↩️ Reply Queue] processedMentions Set size: ${processedMentions.size}`);

    finalReplyQueue.push({ mentionInfo, backendResult });

    // Remove from in-progress set since it's now in reply queue
    inProgressMentions.delete(mentionInfo.tweetId);

    // Triggering is handled by the main browser task loop
}

/**
 * Processes the browser initiation steps for mentions (runs one at a time).
 * TODO: Refactor to use Twitter API for video/space detection instead of Playwright
 */
// Track when worker last started to detect stuck state
let lastWorkerStartTime: number | null = null;
const WORKER_TIMEOUT_MS = 600000; // 10 minutes - allows for retry logic with exponential backoff (fetchVideoForMention can take ~7min with 429 retries)

async function runInitiationQueue(): Promise<void> {
    logger.info(`\n${'='.repeat(80)}`);
    logger.info(`[🚀 WORKER CHECK] Initiation Queue Worker Triggered`);
    logger.info(`${'='.repeat(80)}`);

    // Safety check: if worker has been "running" for more than 60s, force reset the flag
    if (isInitiatingProcessing && lastWorkerStartTime) {
        const timeSinceStart = Date.now() - lastWorkerStartTime;
        logger.info(`[🚀 WORKER CHECK] Worker flag is TRUE. Running time: ${(timeSinceStart / 1000).toFixed(0)}s`);

        if (timeSinceStart > WORKER_TIMEOUT_MS) {
            logger.error(`\n${'!'.repeat(80)}`);
            logger.error(`[🚀 WORKER CHECK] ⚠️ WORKER STUCK DETECTED!`);
            logger.error(`[🚀 WORKER CHECK] Worker has been running for ${(timeSinceStart / 1000).toFixed(0)}s (timeout: ${WORKER_TIMEOUT_MS / 1000}s)`);
            logger.error(`[🚀 WORKER CHECK] Queue size: ${mentionQueue.length}`);
            logger.error(`[🚀 WORKER CHECK] Force resetting worker flag...`);
            logger.error(`${'!'.repeat(80)}\n`);
            isInitiatingProcessing = false;
            lastWorkerStartTime = null;
        }
    }

    if (isInitiatingProcessing) {
        logger.info(`[🚀 WORKER CHECK] ⏸️  Worker is BUSY - another mention is being processed`);
        logger.info(`[🚀 WORKER CHECK] Queue size: ${mentionQueue.length}`);
        logger.info(`[🚀 WORKER CHECK] Skipping this cycle. Will check again in 5 seconds.`);
        logger.info(`${'='.repeat(80)}\n`);
        return;
    }

    if (mentionQueue.length === 0) {
        logger.info(`[🚀 WORKER CHECK] ✅ Worker is FREE but queue is EMPTY - nothing to do`);
        logger.info(`${'='.repeat(80)}\n`);
        return;
    }

    logger.info(`[🚀 WORKER CHECK] ✅ Worker is FREE and queue has ${mentionQueue.length} mention(s) to process`);
    logger.info(`[🚀 WORKER CHECK] 🟢 LOCKING worker (setting flag to TRUE)...`);
    isInitiatingProcessing = true;
    lastWorkerStartTime = Date.now();
    logger.info(`[🚀 WORKER CHECK] Worker is now LOCKED at ${new Date().toISOString()}`);
    logger.info(`${'='.repeat(80)}\n`);

    const queuePreview = mentionQueue.slice(0, 5).map(m => `${m.tweetId} (${m.username})`).join(', ');
    const remainingCount = Math.max(0, mentionQueue.length - 5);

    logger.info(`\n${'▶'.repeat(80)}`);
    logger.info(`[📋 QUEUE STATUS] Current Queue Size: ${mentionQueue.length}`);
    logger.info(`[📋 QUEUE STATUS] Next mentions: ${queuePreview}${remainingCount > 0 ? ` + ${remainingCount} more` : ''}`);
    logger.info(`${'▶'.repeat(80)}\n`);

    const mentionToProcess = mentionQueue.shift();
    if (!mentionToProcess) {
        logger.error(`\n${'!'.repeat(80)}`);
        logger.error(`[🚀 ERROR] Queue shift returned null/undefined (race condition?)`);
        logger.error(`[🚀 ERROR] 🔴 UNLOCKING worker (setting flag to FALSE)...`);
        logger.error(`${'!'.repeat(80)}\n`);
        isInitiatingProcessing = false;
        lastWorkerStartTime = null;
        return;
    }

    processedCount++;

    logger.info(`\n${'█'.repeat(80)}`);
    logger.info(`[🎯 PROCESSING] Starting Mention #${processedCount}`);
    logger.info(`[🎯 PROCESSING] Tweet ID: ${mentionToProcess.tweetId}`);
    logger.info(`[🎯 PROCESSING] Username: @${mentionToProcess.username}`);
    logger.info(`[🎯 PROCESSING] Text: "${mentionToProcess.text}"`);
    logger.info(`[🎯 PROCESSING] Has Video: ${mentionToProcess.hasVideo ? 'YES' : 'NO'}`);
    if (mentionToProcess.videoM3u8Url) {
        logger.info(`[🎯 PROCESSING] Video URL: ${mentionToProcess.videoM3u8Url}`);
    }
    logger.info(`[🎯 PROCESSING] Remaining in queue: ${mentionQueue.length}`);
    logger.info(`${'█'.repeat(80)}\n`);

    // CRITICAL: Mark as in-progress IMMEDIATELY to prevent re-queuing while backend runs
    logger.info(`[🔒 STATE] Adding ${mentionToProcess.tweetId} to inProgressMentions Set to prevent duplicates`);
    inProgressMentions.add(mentionToProcess.tweetId);
    logger.info(`[🔒 STATE] inProgressMentions Set size: ${inProgressMentions.size}`);

    // Update status to 'initiating'
    logger.info(`[💾 DATABASE] Updating mention status to 'initiating' in database...`);
    await updateMentionStatus(mentionToProcess.tweetId, 'initiating');
    logger.info(`[💾 DATABASE] ✅ Status updated to 'initiating'\n`);

    try {
        logger.info(`\n${'🌐'.repeat(80)}`);
        logger.info(`[STEP 1] LANGUAGE DETECTION`);
        logger.info(`${'🌐'.repeat(80)}`);

        // Detect languages
        const { sourceLanguageCode, sourceLanguageName, targetLanguageCode, targetLanguageName } = detectLanguages(mentionToProcess.text);
        logger.info(`[🌐 LANGUAGE] Source: ${sourceLanguageName} (${sourceLanguageCode})`);
        logger.info(`[🌐 LANGUAGE] Target: ${targetLanguageName} (${targetLanguageCode})`);

        // Save detected languages to database
        logger.info(`[💾 DATABASE] Saving detected languages to database...`);
        await updateMentionStatus(mentionToProcess.tweetId, 'initiating', {
            source_language: sourceLanguageCode,
            target_language: targetLanguageCode
        });
        logger.info(`[💾 DATABASE] ✅ Saved languages: ${sourceLanguageCode} → ${targetLanguageCode}`);
        logger.info(`${'🌐'.repeat(80)}\n`);

        // Check if video was found during initial fetch
        // If not, make a direct API call to fetch parent tweet video
        logger.info(`\n${'🎥'.repeat(80)}`);
        logger.info(`[STEP 2] VIDEO DETECTION`);
        logger.info(`${'🎥'.repeat(80)}`);

        if (!mentionToProcess.hasVideo || !mentionToProcess.videoM3u8Url) {
            logger.warn(`[🎥 VIDEO] ⚠️ No video found in initial fetch from mention polling`);
            logger.info(`[🎥 VIDEO] Making direct Twitter API call to fetch parent tweet...`);

            const { videoUrl, parentTweetId } = await fetchVideoForMention(mentionToProcess.tweetId);

            if (videoUrl) {
                logger.info(`[🎥 VIDEO] ✅ SUCCESS! Found video in parent tweet ${parentTweetId}`);
                logger.info(`[🎥 VIDEO] Video URL: ${videoUrl}`);
                mentionToProcess.hasVideo = true;
                mentionToProcess.videoM3u8Url = videoUrl;
            } else {
                logger.warn(`\n${'⚠️'.repeat(80)}`);
                logger.warn(`[🎥 VIDEO] No video found in mention or parent tweet`);
                logger.warn(`[🎥 VIDEO] Silently skipping mention ${mentionToProcess.tweetId} - no error reply will be posted`);
                logger.warn(`${'⚠️'.repeat(80)}\n`);

                // Don't post error reply - just mark as skipped and move on
                logger.info(`[💾 DATABASE] Updating mention status to 'skipped_no_video' in database...`);
                await updateMentionStatus(mentionToProcess.tweetId, 'skipped_no_video', {
                    error_message: 'No video found in mention or parent tweet - skipped without reply'
                });
                logger.info(`[💾 DATABASE] ✅ Status updated to 'skipped_no_video'`);

                // Add to skipped set to prevent retry
                skippedInvalidMentions.add(mentionToProcess.tweetId);

                logger.info(`[🔒 STATE] Removing ${mentionToProcess.tweetId} from inProgressMentions Set`);
                inProgressMentions.delete(mentionToProcess.tweetId);

                logger.info(`\n${'🔓'.repeat(80)}`);
                logger.info(`[WORKER EXIT] Mention skipped - unlocking worker`);
                logger.info(`[WORKER EXIT] 🔴 Setting worker flag to FALSE`);
                logger.info(`${'🔓'.repeat(80)}\n`);

                isInitiatingProcessing = false;
                lastWorkerStartTime = null;
                return;
            }
        } else {
            logger.info(`[🎥 VIDEO] ✅ Video found during initial mention polling`);
        }

        logger.info(`[🎥 VIDEO] Final video URL: ${mentionToProcess.videoM3u8Url}`);
        logger.info(`${'🎥'.repeat(80)}\n`);

        // Skip acknowledgement reply to save on API write limits (Basic tier: 3,000 posts/month per user)
        logger.info(`\n${'📦'.repeat(80)}`);
        logger.info(`[STEP 3] SKIPPING ACKNOWLEDGEMENT (saving API write quota)`);
        logger.info(`[🐦 TWITTER] Not posting acknowledgement to stay under rate limits`);
        logger.info(`[🐦 TWITTER] User will receive final reply when video is ready`);
        logger.info(`${'📦'.repeat(80)}\n`);

        // Prepare initiation result
        logger.info(`\n${'📦'.repeat(80)}`);
        logger.info(`[STEP 4] PREPARE DATA FOR BACKEND PROCESSING`);
        logger.info(`${'📦'.repeat(80)}`);

        const spaceId = `video_${mentionToProcess.tweetId}`;
        const spaceTitle = `Video from ${ensureAtSymbol(mentionToProcess.username)}`;

        const initResult: InitiationResult = {
            spaceId,
            spaceTitle,
            m3u8Url: mentionToProcess.videoM3u8Url!,
            mentionInfo: mentionToProcess,
            sourceLanguageCode,
            sourceLanguageName,
            targetLanguageCode,
            targetLanguageName
        };

        logger.info(`[📦 DATA] Space ID: ${spaceId}`);
        logger.info(`[📦 DATA] Space Title: ${spaceTitle}`);
        logger.info(`[📦 DATA] M3U8 URL: ${initResult.m3u8Url}`);
        logger.info(`[📦 DATA] Languages: ${sourceLanguageName} → ${targetLanguageName}`);
        logger.info(`${'📦'.repeat(80)}\n`);

        logger.info(`\n${'⚙️'.repeat(80)}`);
        logger.info(`[STEP 5] START BACKEND PROCESSING (SPEECHLAB)`);
        logger.info(`${'⚙️'.repeat(80)}`);
        logger.info(`[⚙️ BACKEND] Updating database status to 'processing'...`);
        await updateMentionStatus(mentionToProcess.tweetId, 'processing');
        logger.info(`[⚙️ BACKEND] ✅ Database status updated`);
        logger.info(`[⚙️ BACKEND] Calling performBackendProcessing()...`);
        logger.info(`[⚙️ BACKEND] This will: download video → upload to Speechlab → wait for dubbing → download result`);

        const backendResult = await performBackendProcessing(initResult);

        logger.info(`[⚙️ BACKEND] performBackendProcessing() returned`);
        logger.info(`${'⚙️'.repeat(80)}\n`);

        // Queue for final reply
        logger.info(`\n${'🎯'.repeat(80)}`);
        logger.info(`[STEP 6] HANDLE BACKEND RESULT`);
        logger.info(`${'🎯'.repeat(80)}`);

        if (backendResult.success) {
            logger.info(`[✅ SUCCESS] Backend processing completed successfully!`);
            logger.info(`[✅ SUCCESS] Tweet ID: ${mentionToProcess.tweetId}`);
            logger.info(`[✅ SUCCESS] Adding to finalReplyQueue for posting dubbed video to Twitter...`);
            addToFinalReplyQueue(mentionToProcess, backendResult);
            logger.info(`[✅ SUCCESS] Final reply queue size: ${finalReplyQueue.length}`);
            logger.info(`${'🎯'.repeat(80)}\n`);
        } else {
            logger.error(`\n${'❌'.repeat(80)}`);
            logger.error(`[❌ FAILURE] Backend processing failed!`);
            logger.error(`[❌ FAILURE] Tweet ID: ${mentionToProcess.tweetId}`);
            logger.error(`[❌ FAILURE] Error: ${backendResult.error}`);
            logger.error(`${'❌'.repeat(80)}\n`);

            // Get current retry count and increment
            logger.info(`[🔄 RETRY] Fetching current retry count from database...`);
            const existingMention = await getMention(mentionToProcess.tweetId);
            const currentRetryCount = existingMention?.retry_count || 0;
            const newRetryCount = currentRetryCount + 1;

            logger.info(`[🔄 RETRY] Current retry count: ${currentRetryCount}`);
            logger.info(`[🔄 RETRY] New retry count: ${newRetryCount}/3`);

            // If we've reached the retry limit, mark as final_failure
            if (newRetryCount >= 3) {
                logger.error(`\n${'🚫'.repeat(80)}`);
                logger.error(`[🚫 FINAL FAILURE] Mention has failed ${newRetryCount} times`);
                logger.error(`[🚫 FINAL FAILURE] Maximum retries reached - marking as final_failure`);
                logger.error(`[🚫 FINAL FAILURE] This mention will NOT be retried again`);
                logger.error(`${'🚫'.repeat(80)}\n`);

                await updateMentionStatus(mentionToProcess.tweetId, 'final_failure', {
                    error_message: backendResult.error || 'Backend processing failed after 3 attempts',
                    retry_count: newRetryCount
                });
                logger.info(`[💾 DATABASE] ✅ Status updated to 'final_failure' with retry_count=${newRetryCount}`);
            } else {
                logger.warn(`\n${'🔄'.repeat(80)}`);
                logger.warn(`[🔄 RETRY] Marking as 'failed' - will be retried later`);
                logger.warn(`[🔄 RETRY] Retry ${newRetryCount}/3`);
                logger.warn(`${'🔄'.repeat(80)}\n`);

                // Mark as failed with incremented retry count (will be retried)
                await updateMentionStatus(mentionToProcess.tweetId, 'failed', {
                    error_message: backendResult.error || 'Backend processing failed',
                    retry_count: newRetryCount
                });
                logger.info(`[💾 DATABASE] ✅ Status updated to 'failed' with retry_count=${newRetryCount}`);
            }

            // Don't post error reply - saves API quota
            logger.info(`[🐦 TWITTER] ⏭️ Skipping error reply to save API quota - error logged to Supabase`);
        }

    } catch (error: any) {
        logger.error(`\n${'💥'.repeat(80)}`);
        logger.error(`[💥 EXCEPTION] Uncaught error during mention processing!`);
        logger.error(`[💥 EXCEPTION] Tweet ID: ${mentionToProcess.tweetId}`);
        logger.error(`[💥 EXCEPTION] Error type: ${error?.constructor?.name || 'Unknown'}`);
        logger.error(`[💥 EXCEPTION] Error message: ${error?.message || 'No message'}`);
        logger.error(`[💥 EXCEPTION] Stack trace:`);
        if (error?.stack) {
            logger.error(error.stack);
        }
        logger.error(`${'💥'.repeat(80)}\n`);

        await logMentionError(mentionToProcess.tweetId, error, 'initiation');

        // Get current retry count and increment
        logger.info(`[🔄 RETRY] Fetching current retry count from database...`);
        const existingMention = await getMention(mentionToProcess.tweetId);
        const currentRetryCount = existingMention?.retry_count || 0;
        const newRetryCount = currentRetryCount + 1;

        logger.info(`[🔄 RETRY] Current retry count: ${currentRetryCount}`);
        logger.info(`[🔄 RETRY] New retry count: ${newRetryCount}/3`);

        // If we've reached the retry limit, mark as final_failure
        if (newRetryCount >= 3) {
            logger.error(`\n${'🚫'.repeat(80)}`);
            logger.error(`[🚫 FINAL FAILURE] Mention has failed ${newRetryCount} times (uncaught exception)`);
            logger.error(`[🚫 FINAL FAILURE] Maximum retries reached - marking as final_failure`);
            logger.error(`[🚫 FINAL FAILURE] This mention will NOT be retried again`);
            logger.error(`${'🚫'.repeat(80)}\n`);

            await updateMentionStatus(mentionToProcess.tweetId, 'final_failure', {
                error_message: error.message || 'Unknown error during initiation after 3 attempts',
                retry_count: newRetryCount
            });
            logger.info(`[💾 DATABASE] ✅ Status updated to 'final_failure' with retry_count=${newRetryCount}`);
        } else {
            logger.warn(`\n${'🔄'.repeat(80)}`);
            logger.warn(`[🔄 RETRY] Marking as 'failed' - will be retried later (after exception)`);
            logger.warn(`[🔄 RETRY] Retry ${newRetryCount}/3`);
            logger.warn(`${'🔄'.repeat(80)}\n`);

            // Mark as failed with incremented retry count (will be retried)
            await updateMentionStatus(mentionToProcess.tweetId, 'failed', {
                error_message: error.message || 'Unknown error during initiation',
                retry_count: newRetryCount
            });
            logger.info(`[💾 DATABASE] ✅ Status updated to 'failed' with retry_count=${newRetryCount}`);
        }

        // Don't post error reply - saves API quota
        logger.info(`[🐦 TWITTER] ⏭️ Skipping error reply to save API quota - error logged to Supabase`);
    } finally {
        logger.info(`\n${'🔓'.repeat(80)}`);
        logger.info(`[WORKER CLEANUP] Finalizing mention processing`);
        logger.info(`[WORKER CLEANUP] Tweet ID: ${mentionToProcess.tweetId}`);

        // Remove from in-progress
        logger.info(`[🔒 STATE] Removing ${mentionToProcess.tweetId} from inProgressMentions Set`);
        inProgressMentions.delete(mentionToProcess.tweetId);
        logger.info(`[🔒 STATE] inProgressMentions Set size: ${inProgressMentions.size}`);

        logger.info(`[📊 QUEUE] Mentions remaining in queue: ${mentionQueue.length}`);
        logger.info(`[📊 STATS] Total mentions processed since startup: ${processedCount}`);

        logger.info(`[WORKER CLEANUP] 🔴 UNLOCKING worker (setting flag to FALSE)`);
        isInitiatingProcessing = false;
        lastWorkerStartTime = null;
        logger.info(`[WORKER CLEANUP] Worker is now available for next mention`);
        logger.info(`${'🔓'.repeat(80)}\n`);
    }
}

/**
 * Processes the final reply queue (runs one at a time).
 */
async function runFinalReplyQueue(): Promise<void> {
    if (isPostingFinalReply || finalReplyQueue.length === 0) {
        return;
    }

    isPostingFinalReply = true;
    logger.info(`[↩️ Reply Queue] Starting API-based reply worker. Queue size: ${finalReplyQueue.length}`);

    const replyData = finalReplyQueue.shift(); 
    if (!replyData) {
        isPostingFinalReply = false;
        logger.warn('[↩️ Reply Queue] Worker started but queue was empty.');
        return;
    }
    
    const { mentionInfo, backendResult } = replyData;
    logger.info(`[↩️ Reply Queue] Processing final reply for ${mentionInfo.tweetId}. Backend Success: ${backendResult.success}`);

    // Note: Mention should already be marked as processed in addToFinalReplyQueue() (line ~1197)
    // This prevents duplicates from being added to the queue in the first place
    logger.info(`[↩️ Reply Queue] Mention ${mentionInfo.tweetId} marked as processed: ${processedMentions.has(mentionInfo.tweetId)}`);

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
            // CRITICAL: Must include @ symbol to mention the user
            finalMessage = `${ensureAtSymbol(mentionInfo.username)} Your video dubbed to ${targetLanguageName}!\n\nDisclaimer: this content is not certified for accuracy`;

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
                    // Don't include URL yet - will add it only if Twitter upload fails
                } else {
                    logger.warn(`[↩️ Reply Queue] Failed to download video for attachment. Will include URL in text.`);
                    finalMessage += `\n\nWatch here: ${backendResult.publicVideoUrl}`;
                }
            } catch (videoDownloadError) {
                logger.error(`[↩️ Reply Queue] Error downloading video for attachment:`, videoDownloadError);
                finalMessage += `\n\nWatch here: ${backendResult.publicVideoUrl}`;
            }
        } else if (hasMp3Link) {
            // MP3 is available - construct the success message
            // Only include S3 link (no SpeechLab sharing link)
            finalMessage = `${ensureAtSymbol(mentionInfo.username)} Your ${sourceLanguageName} to ${targetLanguageName} dub is ready! 🎉\n\nWatch here: ${backendResult.publicMp3Url}\n\nDisclaimer: this content is not certified for accuracy`;

        } else {
            // Neither video nor MP3 is available, even though backendResult.success is true
            // DON'T POST ERROR MESSAGE - SKIP THIS MENTION TO SAVE API QUOTA
            logger.warn(`[↩️ Reply Queue] Backend succeeded for ${mentionInfo.tweetId} but no video/MP3 URLs available. SKIPPING reply to save API quota.`);
            logger.warn(`[↩️ Reply Queue] Error details: ${backendResult.error || 'Unknown error'}`);

            // Check if this was supposed to be a VIDEO or AUDIO source
            if (mentionInfo.hasVideo) {
                logger.warn(`[↩️ Reply Queue] Video source but video URL missing for tweet ${mentionInfo.tweetId}`);
                if (hasSharingLink) {
                    logger.info(`[↩️ Reply Queue] Sharing link available but skipping: ${backendResult.sharingLink}`);
                }
                if (backendResult.projectId) {
                    logger.info(`[↩️ Reply Queue] Project ID available but skipping: ${backendResult.projectId}`);
                }
                // DON'T construct error message - just skip
                isPostingFinalReply = false; // CRITICAL: Reset flag before early return
                return; // Exit early, don't post anything
            } else {
                // Audio source but MP3 is missing - also skip to save API quota
                logger.warn(`[↩️ Reply Queue] Backend succeeded for ${mentionInfo.tweetId} but MP3 link is missing. SKIPPING reply to save API quota.`);
                if (hasSharingLink) {
                    logger.info(`[↩️ Reply Queue] Sharing link available but skipping: ${backendResult.sharingLink}`);
                }
                if (backendResult.projectId) {
                    logger.info(`[↩️ Reply Queue] Project ID available but skipping: ${backendResult.projectId}`);
                }
                // DON'T construct error message - just skip
                isPostingFinalReply = false; // CRITICAL: Reset flag before early return
                return; // Exit early, don't post anything
            }
        }
        // --- END MODIFIED SECTION ---

    } else {
        // Backend failed - don't post error reply to save API quota
        logger.warn(`[↩️ Reply Queue] Backend failed for ${mentionInfo.tweetId}. Error: ${backendResult.error || 'Unknown'}`);
        logger.info(`[↩️ Reply Queue] ⏭️ Skipping error reply to save API quota - error logged to Supabase`);

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

        // Exit early - don't post anything
        isPostingFinalReply = false;
        return;
    }

    // --- ADDED: Log the final constructed message before sending ---
    logger.info(`[↩️ Reply Queue] Final constructed reply text: ${finalMessage}`);
    // --- END ADDED SECTION ---

    // Note: Mention was already added to processedMentions in addToFinalReplyQueue() (line ~1197)
    // This prevents duplicate posts even if the same mention is processed multiple times
    logger.info(`[↩️ Reply Queue] Mention ${mentionInfo.tweetId} should already be in processedMentions Set`);
    logger.info(`[↩️ Reply Queue] processedMentions.has(${mentionInfo.tweetId}): ${processedMentions.has(mentionInfo.tweetId)}`);

    // --- Posting Logic (Single Reply) ---
    let postSuccess = false;
    let mediaUploaded = false;

    try {
        // --- Post Final Reply ---
        logger.info(`[↩️ Reply Queue] Posting final reply via Twitter API...`);
        const postResult = await postReplyWithMedia(
            finalMessage,
            mentionInfo.tweetId,
            mediaPathToAttach // Media only attached if applicable
        );

        postSuccess = postResult.success;
        mediaUploaded = postResult.mediaUploaded;
        const dubReplyTweetId = postResult.tweetId;

        // Save the dub reply tweet ID for metrics tracking
        if (dubReplyTweetId) {
            logger.info(`[↩️ Reply Queue] 📊 Saving dub reply tweet ID: ${dubReplyTweetId}`);
            try {
                await updateMentionStatus(mentionInfo.tweetId, 'processing', {
                    dub_reply_tweet_id: dubReplyTweetId,
                    dub_reply_tweet_url: `https://twitter.com/dubbingagent/status/${dubReplyTweetId}`
                });
                logger.info(`[↩️ Reply Queue] ✅ Saved dub reply tweet ID for metrics tracking`);
            } catch (saveError) {
                logger.error(`[↩️ Reply Queue] ❌ Failed to save dub reply tweet ID:`, saveError);
            }
        }

        // If Twitter upload failed but we have a video URL, add it as fallback
        if (postSuccess && !mediaUploaded && mediaPathToAttach && backendResult.publicVideoUrl) {
            logger.warn(`[↩️ Reply Queue] ⚠️ Twitter video upload failed, but reply was posted. Adding S3 link as follow-up...`);

            // Post a follow-up reply with the S3 link
            const followUpMessage = `Watch here: ${backendResult.publicVideoUrl}`;
            try {
                const followUpResult = await postReplyWithMedia(
                    followUpMessage,
                    mentionInfo.tweetId,
                    undefined // No media attachment
                );

                if (followUpResult.success) {
                    logger.info(`[↩️ Reply Queue] ✅ Posted S3 link as follow-up reply`);
                } else {
                    logger.error(`[↩️ Reply Queue] ❌ Failed to post S3 link follow-up`);
                }
            } catch (followUpError) {
                logger.error(`[↩️ Reply Queue] ❌ Error posting S3 link follow-up:`, followUpError);
            }
        }

        if (postSuccess) {
            logger.info(`[↩️ Reply Queue] Successfully posted final reply via Twitter API for ${mentionInfo.tweetId}.`);

            // Clean up local video file if it was attached
            if (mediaPathToAttach && mediaPathToAttach.endsWith('.mp4')) {
                try {
                    await fs.unlink(mediaPathToAttach);
                    logger.debug(`[↩️ Reply Queue] Cleaned up local video file: ${mediaPathToAttach}`);
                } catch (cleanupErr) {
                    logger.warn(`[↩️ Reply Queue] Failed to cleanup video file:`, cleanupErr);
                }
            }

            // Determine if this should be marked as complete or failed
            // If it's a video mention but we don't have the video URL, mark as failed to enable retry
            const shouldMarkComplete = backendResult.success &&
                (!mentionInfo.hasVideo || backendResult.publicVideoUrl);

            if (shouldMarkComplete) {
                // Update Supabase with completion status
                await updateMentionStatus(mentionInfo.tweetId, 'complete', {
                    third_party_id: backendResult.thirdPartyID,
                    project_id: backendResult.projectId,
                    sharing_link: backendResult.sharingLink,
                    public_video_url: backendResult.publicVideoUrl,
                    public_mp3_url: backendResult.publicMp3Url
                });
            } else {
                // Video URL is missing for a video mention - mark as failed to enable retry
                const detailedError = `Video URL not available from Speechlab. Project completed (${backendResult.projectId}) but video output missing. Error: ${backendResult.error || 'Unknown'}`;
                logger.warn(`[↩️ Reply Queue] Video URL missing for video mention ${mentionInfo.tweetId}. Marking as failed to enable retry.`);
                logger.error(`[↩️ Reply Queue] Detailed error: ${detailedError}`);
                await updateMentionStatus(mentionInfo.tweetId, 'failed', {
                    third_party_id: backendResult.thirdPartyID,
                    project_id: backendResult.projectId,
                    sharing_link: backendResult.sharingLink,
                    error_message: detailedError
                });
            }

            // --- Mark Processed After Successful Reply ---
            if (shouldMarkComplete) { // Only mark processed if truly complete
                // Note: Already added to processedMentions Set before posting (line ~1672)
                // No need to call markMentionAsProcessed again here
                logger.info(`[↩️ Reply Queue] Mention ${mentionInfo.tweetId} already in processedMentions Set.`);
                try {
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
                 logger.warn(`[↩️ Reply Queue] Backend failed for ${mentionInfo.tweetId}. NOT marking as processed - will retry on restart.`);

                 // Update Supabase with failed status (but don't mark as processed)
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
            logger.warn(`[↩️ Reply Queue] Failed to post final reply via Twitter API for ${mentionInfo.tweetId}. NOT marking as processed - will retry on restart.`);

            // CRITICAL: Remove from processedMentions to allow retry
            logger.info(`[↩️ Reply Queue] Removing ${mentionInfo.tweetId} from processedMentions Set to allow retry`);
            processedMentions.delete(mentionInfo.tweetId);

            // Get current retry count and increment
            const existingMention = await getMention(mentionInfo.tweetId);
            const currentRetryCount = existingMention?.retry_count || 0;
            const newRetryCount = currentRetryCount + 1;

            logger.info(`[↩️ Reply Queue] Retry count for ${mentionInfo.tweetId}: ${newRetryCount}/3`);

            // If we've reached the retry limit, mark as final_failure
            if (newRetryCount >= 3) {
                logger.warn(`[↩️ Reply Queue] ❌ Mention ${mentionInfo.tweetId} has failed ${newRetryCount} times - marking as final_failure`);
                await updateMentionStatus(mentionInfo.tweetId, 'final_failure', {
                    error_message: 'Failed to post reply after 3 attempts',
                    retry_count: newRetryCount
                });
                // Keep in processedMentions since it's final_failure
                processedMentions.add(mentionInfo.tweetId);
            } else {
                // Mark as failed with incremented retry count (will be retried)
                await updateMentionStatus(mentionInfo.tweetId, 'failed', {
                    error_message: 'Failed to post reply',
                    retry_count: newRetryCount
                });
                // Leave out of processedMentions to allow retry
            }

            // Log to error log file
            logMentionError(mentionInfo.tweetId, 'Failed to post reply', 'reply');
        }
    } catch (replyError) {
        logger.error(`[↩️ Reply Queue] CRITICAL: Error posting final Twitter API reply for ${mentionInfo.tweetId}:`, replyError);

        // CRITICAL: Remove from processedMentions to allow retry
        logger.info(`[↩️ Reply Queue] Removing ${mentionInfo.tweetId} from processedMentions Set to allow retry after exception`);
        processedMentions.delete(mentionInfo.tweetId);

        // Get current retry count and increment
        const existingMention = await getMention(mentionInfo.tweetId);
        const currentRetryCount = existingMention?.retry_count || 0;
        const newRetryCount = currentRetryCount + 1;

        logger.info(`[↩️ Reply Queue] Retry count for ${mentionInfo.tweetId}: ${newRetryCount}/3`);

        // If we've reached the retry limit, mark as final_failure
        if (newRetryCount >= 3) {
            logger.warn(`[↩️ Reply Queue] ❌ Mention ${mentionInfo.tweetId} has failed ${newRetryCount} times - marking as final_failure`);
            await updateMentionStatus(mentionInfo.tweetId, 'final_failure', {
                error_message: replyError instanceof Error ? replyError.message + ' (after 3 attempts)' : String(replyError) + ' (after 3 attempts)',
                retry_count: newRetryCount
            });
            // Keep in processedMentions since it's final_failure
            processedMentions.add(mentionInfo.tweetId);
        } else {
            // Mark as failed with incremented retry count (will be retried)
            await updateMentionStatus(mentionInfo.tweetId, 'failed', {
                error_message: replyError instanceof Error ? replyError.message : String(replyError),
                retry_count: newRetryCount
            });
            // Leave out of processedMentions to allow retry
        }

        // Log to error log file
        logMentionError(mentionInfo.tweetId, replyError, 'reply');
    } finally {
        logger.info(`[↩️ Reply Queue] Finished Twitter API reply work for ${mentionInfo.tweetId}.`);
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

// Browser trigger functions removed - using Twitter API instead
// TODO: Refactor to use API-based queue workers

/**
 * Helper function to ensure username has @ prefix (exactly one)
 * Removes any existing @ symbols and adds one
 */
function ensureAtSymbol(username: string): string {
    return `@${username.replace(/^@+/, '')}`;
}

// --- Main Daemon Logic ---
async function main() {
    logger.info('[😈 Daemon] Starting Mention Monitoring Daemon...');
    logger.info('[😈 Daemon] LOG_LEVEL set to: ' + config.LOG_LEVEL);

    // Initialize Supabase
    logger.info('[😈 Daemon] Initializing Supabase connection...');
    initSupabase();

    // Load ONLY completed/failed mentions from Supabase
    // Mentions in 'processing' or 'initiating' state will be retried (crash recovery)
    logger.info('[😈 Daemon] Loading completed/failed mentions from Supabase...');
    const supabaseProcessedMentions = await getAllProcessedMentions();
    for (const tweetId of supabaseProcessedMentions) {
        processedMentions.add(tweetId);
    }
    logger.info(`[😈 Daemon] Loaded ${supabaseProcessedMentions.size} completed/failed mentions from Supabase`);
    logger.info('[😈 Daemon] ♻️ Mentions in processing/initiating state will be retried (crash recovery)');

    // Load unprocessed mentions from database and add to queue
    logger.info('[😈 Daemon] Loading unprocessed mentions from Supabase to queue...');
    const unprocessedMentions = await getUnprocessedMentions();

    if (unprocessedMentions.length > 0) {
        logger.info(`[😈 Daemon] Found ${unprocessedMentions.length} unprocessed mentions in database`);

        for (const dbMention of unprocessedMentions) {
            // Skip if already in queue or in-progress
            if (inProgressMentions.has(dbMention.tweet_id) ||
                mentionQueue.some(m => m.tweetId === dbMention.tweet_id)) {
                continue;
            }

            // Validate if it's a valid dubbing request
            if (!isValidDubbingRequest(dbMention.tweet_text)) {
                logger.info(`[😈 Daemon] Skipping invalid mention ${dbMention.tweet_id} from database`);
                skippedInvalidMentions.add(dbMention.tweet_id);
                continue;
            }

            // Add to queue
            const mentionInfo: MentionInfo = {
                tweetId: dbMention.tweet_id,
                tweetUrl: dbMention.tweet_url || `https://twitter.com/${dbMention.username}/status/${dbMention.tweet_id}`,
                username: dbMention.username,
                parentUsername: dbMention.parent_username || undefined,
                text: dbMention.tweet_text,
                hasVideo: false, // Will be fetched on-demand
                videoM3u8Url: undefined
            };

            mentionQueue.push(mentionInfo);
            logger.info(`[😈 Daemon] Loaded mention ${dbMention.tweet_id} (@${dbMention.username}) from database - status: ${dbMention.status}, retry: ${dbMention.retry_count || 0}/3`);
        }

        logger.info(`[😈 Daemon] ✅ Added ${mentionQueue.length} unprocessed mentions to queue from database`);
    } else {
        logger.info('[😈 Daemon] No unprocessed mentions found in database');
    }

    // Test Twitter API connection
    logger.info('[😈 Daemon] Testing Twitter API connection...');
    const apiTestSuccess = await testTwitterApiConnection();
    if (!apiTestSuccess) {
        logger.error('[😈 Daemon] ❌ Twitter API test failed! Please check your credentials.');
        logger.error('[😈 Daemon] Exiting daemon...');
        process.exit(1);
    }

    // Set up more verbose logging if needed
    if (config.LOG_LEVEL === 'debug') {
        logger.info('[😈 Daemon] Debug logging enabled - will show detailed execution flow');
    }

    let mainLoopIntervalId: NodeJS.Timeout | null = null; // Keep track of main polling interval
    let projectLogIntervalId: NodeJS.Timeout | null = null; // Keep track of project logging interval

    // Graceful shutdown handler
    const shutdown = async (signal: string) => {
        logger.info(`[😈 Daemon] Received ${signal}. Shutting down gracefully...`);
        if (mainLoopIntervalId) clearInterval(mainLoopIntervalId);
        mainLoopIntervalId = null; // Prevent further polling calls
        if (projectLogIntervalId) clearInterval(projectLogIntervalId);
        projectLogIntervalId = null; // Prevent further project logging

        logger.info('[😈 Daemon] Shutdown complete.');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Global error handlers to prevent daemon crashes
    process.on('uncaughtException', (error) => {
        logger.error('[😈 Daemon] 🚨 UNCAUGHT EXCEPTION - Daemon should continue:', error);
        logger.error('[😈 Daemon] Stack:', error.stack);
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error('[😈 Daemon] 🚨 UNHANDLED REJECTION - Daemon should continue:', reason);
        logger.error('[😈 Daemon] Promise:', promise);
    });

    try {
        // Note: processedMentions already loaded from Supabase above (line 1476-1480)
        // Using Supabase as single source of truth - no JSON file needed
        logger.info('[😈 Daemon] Using Supabase as single source of truth for processed mentions');

        // Log active projects at startup (still uses JSON temporarily for project status)
        logger.info('[😈 Daemon] Logging active projects at startup:');
        await logActiveProjects();
        
        // Set up periodic project logging (every 30 minutes)
        const PROJECT_LOG_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
        logger.info(`[😈 Daemon] Setting up periodic project logging (every ${PROJECT_LOG_INTERVAL_MS/60000} minutes)`);
        projectLogIntervalId = setInterval(async () => {
            logger.info('[😈 Daemon] Periodic active project log:');
            await logActiveProjects();
        }, PROJECT_LOG_INTERVAL_MS);

        logger.info('[😈 Daemon] Using Twitter API for mention monitoring - no browser required.');
        logger.info(`[😈 Daemon] Twitter API credentials - API Key: ${config.TWITTER_API_KEY ? '✓ Set' : '❌ Missing'}, Access Token: ${config.TWITTER_ACCESS_TOKEN ? '✓ Set' : '❌ Missing'}`);

        logger.info('[😈 Daemon] Ready to monitor mentions via Twitter API.');

        const skipInitialMentions = process.env.SKIP_INITIAL_MENTIONS === 'true'; // Check environment variable

        // --- Main Polling Loop Setup ---
        const pollMentions = async () => {
            logger.info('[😈 Daemon Polling] Polling for new mentions...');
            try {
                // Fetch up to MAX_MENTIONS_PER_POLL mentions (default 100)
                // Videos are already extracted during fetchMentions from parent tweets
                const maxMentions = config.MAX_MENTIONS_PER_POLL || 100;
                const apiMentions = await fetchMentions(undefined, maxMentions);

                // Convert MentionData to MentionInfo format
                // DO NOT filter by processedMentions here - we need to check Supabase as source of truth
                const mentions: MentionInfo[] = apiMentions.map(m => ({
                    tweetId: m.tweetId,
                    tweetUrl: m.tweetUrl,
                    username: m.username,
                    profileImageUrl: m.profileImageUrl,
                    parentUsername: m.parentUsername,
                    parentTweetUrl: m.parentTweetUrl,
                    parentTweetText: m.parentTweetText,
                    parentTweetCategory: m.parentTweetCategory,
                    parentTweetCategoryId: m.parentTweetCategoryId,
                    parentTweetDomains: m.parentTweetDomains,
                    text: m.text,
                    hasVideo: m.hasVideo,
                    videoM3u8Url: m.videoUrl
                }));

                logger.info(`[😈 Daemon Polling] Fetched ${mentions.length} mentions from Twitter API`);
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
                    // Skip if already seen in this batch
                    if (seenInThisBatch.has(mention.tweetId)) {
                        continue;
                    }

                    // Mark as seen in this batch
                    seenInThisBatch.add(mention.tweetId);

                    // Skip tweets from the bot itself (avoid processing own replies as mentions)
                    if (config.TWITTER_USERNAME) {
                        const botUsername = config.TWITTER_USERNAME.toLowerCase();
                        const mentionUsername = mention.username.toLowerCase().replace('@', '');
                        if (mentionUsername === botUsername) {
                            logger.debug(`[🔔 Mention] Skipping bot's own tweet: ${mention.tweetId}`);
                            continue;
                        }
                    }

                    // Skip if currently in progress or queued (avoid duplicate processing in same run)
                    if (inProgressMentions.has(mention.tweetId) ||
                        currentQueueIds.has(mention.tweetId) ||
                        replyQueueIds.has(mention.tweetId)) {
                        logger.debug(`[🔔 Mention] ${mention.tweetId} already queued or in-progress - skipping`);
                        continue;
                    }

                    // Check Supabase for existing mention status (SINGLE SOURCE OF TRUTH)
                    // This makes the system resilient to crashes - all state is in the database
                    const existingMention = await getMention(mention.tweetId);

                    if (existingMention) {
                        logger.debug(`[🔔 Mention] Found mention ${mention.tweetId} in Supabase with status: ${existingMention.status}`);

                        // Skip if status is 'complete' OR 'final_failure' (both are terminal states)
                        if (existingMention.status === 'complete' || existingMention.status === 'final_failure') {
                            logger.debug(`[🔔 Mention] Mention ${mention.tweetId} is ${existingMention.status}. Skipping.`);
                            // Add to in-memory set to speed up future checks in this run
                            processedMentions.add(mention.tweetId);
                            continue;
                        }

                        // If status is 'processing' and it has all the completion data (video URLs, sharing link),
                        // it means it was successfully processed but just never marked complete. Mark it complete now.
                        if (existingMention.status === 'processing' &&
                            existingMention.public_video_url &&
                            existingMention.sharing_link) {
                            logger.info(`[🔔 Mention] Mention ${mention.tweetId} has status 'processing' but has all completion data. Marking as complete.`);
                            await updateMentionStatus(mention.tweetId, 'complete');
                            processedMentions.add(mention.tweetId);
                            continue;
                        }

                        // Check if retry limit reached
                        const retryCount = existingMention.retry_count || 0;
                        if (retryCount >= 3) {
                            logger.warn(`[🔔 Mention] Mention ${mention.tweetId} has retry_count=${retryCount} >= 3. Should be final_failure but found as '${existingMention.status}'. Marking as final_failure.`);
                            await updateMentionStatus(mention.tweetId, 'final_failure', {
                                error_message: `Exceeded retry limit (${retryCount} attempts)`,
                                retry_count: retryCount
                            });
                            processedMentions.add(mention.tweetId);
                            continue;
                        }

                        // For any other status (pending, initiating, failed) or processing without completion data, retry
                        logger.info(`[🔔 Mention] Mention ${mention.tweetId} has status '${existingMention.status}' with retry_count=${retryCount}. Will retry processing.`);
                    }

                    // VALIDATE FIRST - Only save valid dubbing requests to Supabase
                    if (!isValidDubbingRequest(mention.text)) {
                        logger.info(`[😈 Daemon Polling] ⏭️  Mention ${mention.tweetId} is not a valid dubbing request - skipping (not saving to DB)`);
                        skippedInvalidMentions.add(mention.tweetId);
                        continue;
                    }

                    // SAVE TO SUPABASE (only valid mentions reach here)
                    const retryCount = existingMention?.retry_count || 0;
                    // Map Twitter domains to custom categories automatically
                    const { mapDomainsToCategories } = await import('./services/supabaseService');
                    const customCategories = await mapDomainsToCategories(mention.parentTweetDomains || []);

                    if (customCategories.length > 0) {
                        logger.info(`[📊 Categories] Mapped ${mention.tweetId} to: ${customCategories.join(', ')}`);
                    }

                    // Translate parent tweet text to target language
                    let translatedParentText: string | undefined;
                    if (mention.parentTweetText && mention.targetLanguage) {
                        try {
                            const { translateText } = await import('./services/translationService');
                            translatedParentText = await translateText(mention.parentTweetText, mention.targetLanguage);
                            logger.info(`[🌐 Translation] Translated parent tweet for ${mention.tweetId} to ${mention.targetLanguage}`);
                        } catch (error) {
                            logger.error(`[🌐 Translation] Failed to translate parent tweet for ${mention.tweetId}:`, error);
                            // Continue without translation - not critical
                        }
                    }

                    const saveSuccess = await upsertMention({
                        tweet_id: mention.tweetId,
                        username: mention.username,
                        twitter_profile_image_url: mention.profileImageUrl,
                        parent_username: mention.parentUsername,
                        parent_tweet_url: mention.parentTweetUrl,
                        parent_tweet_text: mention.parentTweetText,
                        parent_tweet_text_translated: translatedParentText,
                        parent_tweet_category: mention.parentTweetCategory,
                        parent_tweet_category_id: mention.parentTweetCategoryId,
                        parent_tweet_domains: mention.parentTweetDomains,
                        custom_category: customCategories,
                        tweet_url: mention.tweetUrl,
                        tweet_text: mention.text || '',
                        status: 'pending',
                        retry_count: retryCount
                    });

                    if (!saveSuccess) {
                        logger.error(`[🔔 Mention] Failed to save mention ${mention.tweetId} to Supabase - SKIPPING for safety`);
                        continue;
                    }

                    logger.info(`[🔔 Mention] ${existingMention ? 'Updated' : 'Saved new'} mention ${mention.tweetId} in Supabase with status 'pending'`);

                    // Process the mention (new or retry)
                    newMentionsFound++;
                    const actionType = existingMention ? 'Retrying' : 'Found new';
                    logger.info(`[🔔 Mention] ${actionType} mention: ID=${mention.tweetId}, User=${mention.username}, Text="${mention.text?.substring(0, 50)}${mention.text?.length > 50 ? '...' : ''}"`);

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
                // Continue polling - API will handle rate limiting and errors
            }
        };

        if (skipInitialMentions) {
            logger.warn(`[😈 Daemon] SKIP_INITIAL_MENTIONS flag is set. Marking mentions older than 30 minutes as complete...`);
            try {
                // Fetch mentions once to find what's currently available
                // Videos are NOT fetched here - they'll be fetched on-demand for valid dubbing requests only
                // Fetch up to MAX_MENTIONS_PER_POLL (default 100) to maximize valid requests
                const maxMentions = config.MAX_MENTIONS_PER_POLL || 100;
                const apiMentions = await fetchMentions(undefined, maxMentions);
                const initialMentions: MentionInfo[] = apiMentions
                    .filter(m => !processedMentions.has(m.tweetId))
                    .map(m => ({
                        tweetId: m.tweetId,
                        tweetUrl: m.tweetUrl,
                        username: m.username,
                        parentUsername: m.parentUsername,
                        text: m.text,
                        hasVideo: m.hasVideo,
                        videoM3u8Url: m.videoUrl
                    }));
                logger.info(`[😈 Daemon] Initial scrape found ${initialMentions.length} mentions (already-processed filtered).`);

                const now = Date.now();
                const THIRTY_MINUTES_MS = 30 * 60 * 1000;
                let skippedCount = 0;
                let keptCount = 0;

                for (const mention of initialMentions) {
                    // CRITICAL: Validate if this is a valid dubbing request FIRST
                    if (!isValidDubbingRequest(mention.text)) {
                        logger.info(`[😈 Daemon] ⏭️  Skipping mention ${mention.tweetId} - Not a valid dubbing request`);
                        skippedInvalidMentions.add(mention.tweetId);
                        skippedCount++;
                        continue;
                    }

                    // Check if it's *not* already processed or skipped, just in case
                    if (!processedMentions.has(mention.tweetId) && !skippedInvalidMentions.has(mention.tweetId)) {
                        // Calculate mention age from Twitter Snowflake ID
                        // Twitter Snowflake IDs encode timestamp in first 41 bits
                        const tweetTimestamp = (BigInt(mention.tweetId) >> BigInt(22)) + BigInt(1288834974657); // Twitter epoch
                        const tweetDate = new Date(Number(tweetTimestamp));
                        const mentionAge = now - tweetDate.getTime();
                        const ageMinutes = Math.round(mentionAge / 60000);

                        // Skip adding old mentions to queue (but don't mark as complete)
                        // Recent mentions get processed normally
                        if (mentionAge > THIRTY_MINUTES_MS) {
                            logger.info(`[😈 Daemon] Skipping old mention ${mention.tweetId} (${ageMinutes} min old) - not adding to queue`);
                            skippedCount++;
                        } else {
                            logger.info(`[😈 Daemon] Keeping recent mention ${mention.tweetId} (${ageMinutes} min old) - will process normally.`);
                            keptCount++;
                        }
                    } else {
                         logger.debug(`[😈 Daemon] Initially found mention ${mention.tweetId} was already marked as processed.`);
                    }
                }
                logger.info(`[😈 Daemon] Finished: ${skippedCount} old mentions skipped (not queued), ${keptCount} recent mentions kept for processing.`);

                // If we kept any recent mentions, do an immediate poll to process them
                if (keptCount > 0) {
                    logger.info(`[😈 Daemon] Running immediate poll to process ${keptCount} recent mentions...`);
                    await pollMentions();
                }

                // Start the regular polling interval
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

        // Start API-based queue workers
        logger.info('[🚀 Workers] Starting API-based queue workers...');
        const WORKER_INTERVAL_MS = 5000; // Check queues every 5 seconds

        setInterval(async () => {
            try {
                await runInitiationQueue();
                await runFinalReplyQueue();
            } catch (error) {
                logger.error('[🚀 Workers] Error in queue worker:', error);
            }
        }, WORKER_INTERVAL_MS);

        logger.info(`[🚀 Workers] Queue workers started (checking every ${WORKER_INTERVAL_MS / 1000}s)`);

        // Start stuck mention retry mechanism
        logger.info('[🔄 Retry] Starting stuck mention retry mechanism...');
        const RETRY_CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
        const STUCK_TIMEOUT_MS = 20 * 60 * 1000; // Retry if stuck for 20+ minutes (SpeechLab can take up to 20min)

        // Run immediately on startup to catch any stuck mentions from previous run
        logger.info('[🔄 Retry] Running initial stuck mention check...');
        try {
            await retryStuckMentions(STUCK_TIMEOUT_MS);
        } catch (error) {
            logger.error('[🔄 Retry] Error in initial stuck mention check:', error);
        }

        // Load pending/failed mentions from Supabase on startup (< 6 hours old)
        logger.info('[📊 Startup] Loading unprocessed mentions from Supabase...');
        try {
            const unprocessedMentions = await getUnprocessedMentions();

            if (unprocessedMentions && unprocessedMentions.length > 0) {
                logger.info(`[📊 Startup] Found ${unprocessedMentions.length} unprocessed mentions (< 6 hours old)`);

                for (const mention of unprocessedMentions) {
                    // Convert MentionRecord to MentionInfo format
                    const mentionInfo: MentionInfo = {
                        tweetId: mention.tweet_id,
                        tweetUrl: mention.tweet_url,
                        username: mention.username,
                        parentUsername: mention.parent_username,
                        text: mention.tweet_text,
                        hasVideo: !!mention.m3u8_url,
                        videoM3u8Url: mention.m3u8_url
                    };

                    // Add to initiation queue
                    mentionQueue.push(mentionInfo);
                    logger.info(`[📊 Startup] Added ${mention.status} mention ${mention.tweet_id} to initiation queue`);
                }

                logger.info(`[📊 Startup] ✅ Loaded ${unprocessedMentions.length} mentions to initiation queue`);
            } else {
                logger.info('[📊 Startup] No recent unprocessed mentions found');
            }
        } catch (error) {
            logger.error('[📊 Startup] Error loading unprocessed mentions:', error);
        }

        // Load processing mentions with media ready (ANY age - these are stuck replies)
        logger.info('[📊 Startup] Loading processing mentions with media ready...');
        try {
            const { getProcessingMentionsWithMedia } = await import('./services/supabaseService');
            const processingMentions = await getProcessingMentionsWithMedia();

            if (processingMentions && processingMentions.length > 0) {
                logger.info(`[📊 Startup] Found ${processingMentions.length} processing mentions with media ready`);

                for (const mention of processingMentions) {
                    const mentionInfo: MentionInfo = {
                        tweetId: mention.tweet_id,
                        tweetUrl: mention.tweet_url,
                        username: mention.username,
                        parentUsername: mention.parent_username,
                        text: mention.tweet_text,
                        hasVideo: !!mention.m3u8_url,
                        videoM3u8Url: mention.m3u8_url
                    };

                    const backendResult: BackendResult = {
                        success: true,
                        thirdPartyID: mention.third_party_id || '',
                        projectId: mention.project_id || '',
                        sharingLink: mention.sharing_link || '',
                        publicVideoUrl: mention.public_video_url || '',
                        publicMp3Url: mention.public_mp3_url || ''
                    };

                    addToFinalReplyQueue(mentionInfo, backendResult);
                    logger.info(`[📊 Startup] Added processing mention ${mention.tweet_id} to reply queue`);
                }

                logger.info(`[📊 Startup] ✅ Loaded ${processingMentions.length} mentions to reply queue`);
            } else {
                logger.info('[📊 Startup] No processing mentions with media found');
            }
        } catch (error) {
            logger.error('[📊 Startup] Error loading processing mentions:', error);
        }

        // Then run every 5 minutes
        setInterval(async () => {
            try {
                await retryStuckMentions(STUCK_TIMEOUT_MS);
            } catch (error) {
                logger.error('[🔄 Retry] Error in stuck mention retry:', error);
            }
        }, RETRY_CHECK_INTERVAL_MS);

        logger.info(`[🔄 Retry] Retry mechanism started (checking every ${RETRY_CHECK_INTERVAL_MS / 60000} minutes, timeout: ${STUCK_TIMEOUT_MS / 60000} minutes)`);
        logger.info('[😈 Daemon] Daemon initialization complete. Monitoring mentions...');

    } catch (error) {
        logger.error('[😈 Daemon] Daemon encountered fatal error during initialization or polling:', error);
        // Ensure cleanup happens on fatal error
        if (mainLoopIntervalId) clearInterval(mainLoopIntervalId);
        process.exit(1);
    }

     // Keep alive only if interval is running
     if (mainLoopIntervalId) {
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

main().catch((error) => {
    logger.error('[😈 Daemon] ❌ FATAL: Unhandled error in main():', error);
    logger.error('[😈 Daemon] The daemon has crashed. Please check the logs and restart.');
    process.exit(1);
}); 